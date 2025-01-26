import { watch } from "fs"
import { dirname } from "path"
import { parseArgs } from "util"
import { BunFile, Server } from "bun"
import { getClientMaxBodySize, getMaxWorker, removeToArray, toArray } from "./utils"
import NginxConfigParser from "@webantic/nginx-config-parser"


const { values: argv } = parseArgs({
    options: {
        config: { type: 'string', short: 'c', default: 'config/nginx.conf' },
    }
})

const parser = new NginxConfigParser()
const loadConfig = () => parser.readConfigFile(argv.config, {
    ignoreIncludeErrors: true,
    parseIncludes: true,
})

const global_config = loadConfig()
global_config.cached = {}

watch(dirname(argv.config!), { recursive: true })
    .on('change', (event, file_name) => Object.assign(global_config, loadConfig()))

const HTTP_SWITCHING_PROTOCOLS = 101
const HTTP_NOT_FOUND = 404
const HTTP_OK = 200

type HandlerOpts = {
    req: Request;
    req_url: URL;
    server: Server;
    server_cfg: object;
    path_prefix: string;
}

const location_handlers = {
    async try_files(files: string, opts: HandlerOpts) {
        for (const entry of files?.split(' ') || []) {
            const file_path = opts.server_cfg.root + entry.replace('$uri', opts.req_url.pathname)
            const file: BunFile = Bun.file(file_path)
            // console.info('try_files:', { entry, file_path })

            if (await file.exists())
                return new Response(file, { status: HTTP_OK })

            if (entry === '=404')
                return new Response(null, { status: HTTP_NOT_FOUND })
        }
    },

    async proxy_pass(target_url: string, opts: HandlerOpts) {
        //console.info('proxy_pass:', target_url)

        target_url = target_url + opts.req_url.pathname.slice(opts.path_prefix?.length!) + opts.req_url.search

        //console.info('proxy_pass:', {altered_target_url: target_url})

        if (opts.path_prefix && !opts.req_url.pathname.startsWith(opts.path_prefix)) {
            //console.info(`proxy_pass skipped, rule doesn't match`)
            return
        }

        const data = { target_url }
        if (opts.server.upgrade(opts.req, { data })) {
            // console.info('101 HTTP_SWITCHING_PROTOCOLS', opts.req.url)
            return { status: HTTP_SWITCHING_PROTOCOLS } as Response
        }

        opts.req.headers.delete('host')

        const req_init: RequestInit = {
            headers: opts.req.headers,
            method: opts.req.method,
            body: await opts.req.arrayBuffer(),
        }

        // console.info('forward req')
        return fetch(target_url, req_init)
    },

    async proxy_http_version() { },
    async proxy_set_header() { },
    async proxy_cache_bypass() { },
}

async function runActions(actions: object, opts = {}, response: never) {
    for (const [action, argument] of Object.entries(actions)) { // @ts-ignore
        if (response = await location_handlers[action]?.(argument, opts)) {
            setResponseHeaders(response, global_config.http.res_headers)
            setResponseHeaders(response, opts.server_cfg.res_headers)
            setResponseHeaders(response, actions.res_headers)
            return response
        }
    }
}

export function refineConfig(config: object) {
    config.http.servers = {}
    config.http.res_headers = removeToArray(config.http, 'add_header')

    for (const server of removeToArray(config.http, 'server')) {
        for (const listen_cfg of toArray(server.listen)) {
            let addr = listen_cfg.split(' ')[0]

            if (Number.isInteger(+addr)) {
                server.port = +addr
                server.hostname = 'localhost';
                config.http.servers[addr] = server
                continue
            }

            const [,, hostname, port] = addr.replace('$PORT', Bun.env.PORT).match(/((.+):)?(\w+)$/)

            if (port) {
                server.port = +(port.replace('$PORT', Bun.env.PORT))
                server.hostname = hostname ? hostname.replace('$HOSTNAME', Bun.env.HOSTNAME) : 'localhost';
                config.http.servers[server.port] = server
            }
        }

        server.res_headers = removeToArray(server, 'add_header')
    }

    return config.http.servers
}

function setResponseHeaders(response: Response, headers: string[]) {
    for (const header of headers) {
        const [name, value] = header.split(' ')
        response.headers.set(name, value)
    }
}

function onWscOpen(wsc: WebSocket, callback: Function) {
    setTimeout(() => {
        // console.info('upstream_wsc.readyState:', wsc.readyState)
        wsc.readyState === wsc.OPEN
            ? callback(wsc)
            : onWscOpen(wsc, callback)
    }, 10)
}

function startServer(server_cfg: object) {
    server_cfg.location_actions = {}

    const server = Bun.serve({
        reusePort: true,
        port: server_cfg.port,
        hostname: server_cfg.hostname,
        maxRequestBodySize: getClientMaxBodySize(global_config),

        async fetch(req: Request, server: Server, response: never) {
            const req_url = new URL(req.url)
            const opts: HandlerOpts = { req, req_url, server, server_cfg }

            for (const [path_prefix, actions] of Object.entries(server_cfg.location_actions || {})) {
                if (req_url.pathname.startsWith(path_prefix)) {
                    opts.path_prefix = path_prefix
                    return runActions(actions, opts)
                }
            }

            for (const [directive, config] of Object.entries(server_cfg)) {
                //console.info({directive, actions})

                if (directive.startsWith('location ')) {
                    const location_actions = {}
                    const actions_cfg = toArray(config)

                    server_cfg.location_actions[opts.path_prefix = directive.slice(9)] = location_actions
                    location_actions.res_headers = []

                    for (const actions of actions_cfg) {
                        //console.info({actions})
                        location_actions.res_headers.push(...removeToArray(actions, 'add_header'))
                        Object.assign(location_actions, actions)
                    }

                    if (response = await runActions(location_actions, opts))
                        return response
                }
            }

            console.warn('No handler matched for url:', req.url)
        },

        websocket: {
            open(wss) {
                wss.upstream_wsc = new WebSocket(wss.data.target_url)

                //console.info('sws.open', sws)
                // proxy('chat').ws(server, ws, 'open')

                wss.upstream_wsc.addEventListener('message', (e) => {
                    // console.info('upstream_wsc.onmessage', e.data)
                    wss.send(e.data)
                })
            },
            message(wss, message) {
                //const ws: WebSocket = sws.data.req.upstreamWs
                //console.info('sws.message', {sws, message})
                // proxy_fe.ws(server, message)

                onWscOpen(wss.upstream_wsc, (wsc: WebSocket) => {
                    wsc.send(message)
                    // wsc.close()
                    // wsc.terminate()
                })
            }
        },
        error(e) {
            if (e.name === 'ConnectionRefused')
                return new Response(`Upstream error: ${e.message} ${e.path}`, { status: 500 })
        },
    })

    console.info(`Server started on ${server.url}`)
}

const servers = Object.values(refineConfig(global_config))

for (let i = 0; i < getMaxWorker(global_config); i++) {
    for (const config of servers) {
        startServer(config)
    }
}

// console.info(`Child worker (${process.pid}) started`)