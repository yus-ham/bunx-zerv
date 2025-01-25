import { watch } from "fs"
import { BunFile, Server } from "bun"
import { getClientMaxBodySize } from "./utils"
import NginxConfigParser from "@webantic/nginx-config-parser"

const parser = new NginxConfigParser()
const loadConfig = () => parser.readConfigFile('config/nginx.conf', {
    ignoreIncludeErrors: true,
    parseIncludes: true,
})

const global_config = loadConfig()

watch('config', { recursive: true })
    .on('change', (event, file_name) => {
        // console.info(event, file_name)
        Object.assign(global_config, loadConfig())
        // console.info('config reloaded')
    })

const HTTP_SWITCHING_PROTOCOLS = 101
const HTTP_NOT_FOUND = 404

type ActionOpts = {
    req: Request;
    req_url: URL;
    server: Server;
    path_prefix: string;
}

const directive_actions = {
    async try_files(files: string, opts: ActionOpts) {
        for (const entry of files?.split(' ') || []) {
            const file_path = global_config.http.server.root + entry.replace('$uri', opts.req_url.pathname)
            const file: BunFile = Bun.file(file_path)
            //console.info('try_files:', {entry, file_path})

            if (await file.exists())
                return new Response(file, { status: 200 })

            // console.info({file})

            if (entry === '=404')
                return new Response(null, { status: 404 })
        }
    },

    async proxy_pass(target_url: string, opts: ActionOpts) {
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

function toArray(data: any) {
    return Array.isArray(data) ? data : (data ? [data] : [])
}

function getListens() {
    const listens: Record<string | number, object> = {}

    for (const server of toArray(global_config.http.server)) {
        for (const listen_cfg of toArray(server.listen)) {
            let addr = listen_cfg.split(' ')[0]

            if (Number.isInteger(+addr)) {
                listens[addr] = {
                    port: +addr,
                    hostname: 'localhost',
                }
                continue
            }

            const matches = addr.match(/(.+):(\d+)$/)

            if (matches)
                listens[matches[2]] = {
                    port: +matches[2],
                    hostname: matches[1]
                }
        }
    }

    return listens
}

function onWscOpen(wsc: WebSocket, callback: Function) {
    setTimeout(() => {
        // console.info('upstream_wsc.readyState:', wsc.readyState)
        wsc.readyState === wsc.OPEN
            ? callback(wsc)
            : onWscOpen(wsc, callback)
    }, 10)
}

for (const listen_opts of Object.values(getListens())) {
    Bun.serve({
        ...listen_opts,
        reusePort: true,
        maxRequestBodySize: getClientMaxBodySize(global_config),
        async fetch(req: Request, server: Server) {
            const req_url = new URL(req.url)

            for (const server_cfg of toArray(global_config.http.server)) {
                for (const [directive, actions] of Object.entries(server_cfg)) {
                    //console.info({directive, actions})

                    if (directive.startsWith('location ')) {
                        const path_prefix = directive.slice(9)

                        for (const [action, argument] of Object.entries(actions!)) {
                            //console.info({action, argument})
                            const response = await directive_actions[action](argument, { path_prefix, req, req_url, server })

                            if (response)
                                return response
                            // return console.info('end directive: location:', path_prefix) || response
                        }

                        //console.warn('No handler for location:', path_prefix, req.url)
                    }
                }
            }

            return new Response(Bun.file(global_config.http.server.root))
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
}

console.info(`Child worker (${process.pid}) started`)