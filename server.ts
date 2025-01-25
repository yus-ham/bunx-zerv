import { watch } from "fs"
import { parseArgs } from "util"
import { BunFile, Server } from "bun"
import { getClientMaxBodySize, getMaxWorker } from "./utils"
import NginxConfigParser from "@webantic/nginx-config-parser"
import path from "path"


const {values: argv} = parseArgs({
    options: {
        config: {type: 'string', short: 'c', default: 'config/nginx.conf'},
    }
})

const parser = new NginxConfigParser()
const loadConfig = () => parser.readConfigFile(argv.config, {
    ignoreIncludeErrors: true,
    parseIncludes: true,
})

const global_config = loadConfig()
global_config.cached = {}

watch(path.dirname(argv.config!), { recursive: true })
    .on('change', (event, file_name) => {
        // console.info(event, file_name)
        Object.assign(global_config, loadConfig())
        // console.info('config reloaded')
    })

const HTTP_SWITCHING_PROTOCOLS = 101
const HTTP_NOT_FOUND = 404

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
            //console.info('try_files:', {entry, file_path})

            if (await file.exists())
                return new Response(file, { status: 200 })

            // console.info({file})

            if (entry === '=404')
                return new Response(null, { status: 404 })
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
            //data.upstream_ws = new WebSocket(target_url)

            console.info('101 HTTP_SWITCHING_PROTOCOLS', opts.req.url)
            return { status: HTTP_SWITCHING_PROTOCOLS } as Response
        }

        opts.req.headers.delete('host')

        const req_init: RequestInit = {
            headers: opts.req.headers,
            method: opts.req.method,
            body: await opts.req.arrayBuffer(),
        }

        console.info('forward req')
        return fetch(target_url, req_init)
    },

    async proxy_http_version() { },
    async proxy_set_header() { },
    async proxy_cache_bypass() { },
}

async function runActions(actions_cfg: object[], opts = {}, response: never) {
    for (const actions of actions_cfg) {
        for (const [action, argument] of Object.entries(actions)) { // @ts-ignore
            if (response = await location_handlers[action]?.(argument, opts))
                return response
        }
    }
}

function toArray(data: any) {
    return Array.isArray(data) ? data : (data ? [data] : [])
}

function configServers() {
    const servers = toArray(global_config.http.server)
    global_config.http.server = {}

    for (const server of servers) {
        for (const listen_cfg of toArray(server.listen)) {
            let addr = listen_cfg.split(' ')[0]

            if (Number.isInteger(+addr)) {
                server.port = +addr
                server.hostname = 'localhost'
                global_config.http.server[addr] = server
                continue
            }

            const matches = addr.match(/(.+):(\d+)$/)

            if (matches)
                server.port = +matches[2]
                server.hostname = matches[1]
                global_config.http.server[matches[2]] = server
        }
    }

    return global_config.http.server
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
    server_cfg.locations = {}

    const server = Bun.serve({
        reusePort: true,
        port: server_cfg.port,
        hostname: server_cfg.hostname,
        maxRequestBodySize: getClientMaxBodySize(global_config),

        async fetch(req: Request, server: Server, response: never) {
            const req_url = new URL(req.url)
            const opts: HandlerOpts = { req, req_url, server, server_cfg }

            for (const [path_prefix, actions] of Object.entries(server_cfg.locations || {})) {
                if (req_url.pathname.startsWith(path_prefix)) {
                    opts.path_prefix = path_prefix
                    return runActions(actions as object[], opts)
                }
            }

            for (const [directive, config] of Object.entries(server_cfg)) {
                //console.info({directive, actions})

                if (directive.startsWith('location ')) {
                    const actions = toArray(config)
                    server_cfg.locations[opts.path_prefix = directive.slice(9)] = actions

                    if (response = await runActions(actions, opts))
                        return response

                    console.warn('No handler for location:', opts.path_prefix, req.url)
                }
            }
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

const servers = Object.values(configServers())

for (let i=0; i < getMaxWorker(global_config); i++) {
    for (const config of servers) {
        startServer(config)
    }
}

// console.info(`Child worker (${process.pid}) started`)