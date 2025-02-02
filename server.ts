#!/bin/env bun

import { watch } from "fs"
import { parseArgs } from "util"
import { dirname, join } from "path"
import { networkInterfaces } from "os"
import { BunFile, Server, file } from "bun"
import { getClientMaxBodySize, getMaxWorker, removeToArray, toArray } from "./utils"
import NginxConfigParser from "@webantic/nginx-config-parser"


const HTTP_SWITCHING_PROTOCOLS = 101
const HTTP_NOT_FOUND = 404
const HTTP_OK = 200
const LISTEN_ADDR_RE = /((.+):)?(\d+)$/
const global_config = {}

function parseCLIArgs() {
    try {
        return parseArgs({
            allowPositionals: true,
            options: {
                help: { type: 'boolean', short: 'h' },
                config: { type: 'string', short: 'c', default: 'config/main/default.conf' },
                spa: { type: 'boolean' },
            },
        })
    } catch(err) {
        if (err.message.startsWith('Unexpected argument'))
            return console.error(err.message.slice(0, err.message.indexOf("'. ") + 1))
        let matches
        if (matches = err.message.match(/Option '(-\w)[\s\S]+To specify an option[\s\S]+use '(--[\w]+)/))
            return console.error(`Option '${matches[1]}, ${matches[2]} <value>' argument missing`)
        return console.error(err.message)
    }
}

async function run() {
    const { values: argv, positionals } = parseCLIArgs()

    if (argv?.help)
        return console.info('Usage: zerv [[hostname:]port] [directory] [--spa] [-c, --config <file>]')

    if (argv) {
        const parser = new NginxConfigParser()

        if (!await file(argv.config).exists())
            argv.config = join(import.meta.dirname, argv.config)

        loadConfig(parser, argv.config)

        watch(dirname(dirname(argv.config!)), { recursive: true })
            .on('change', () => loadConfig(parser, argv.config))

        const servers = Object.values(refineConfig(argv, positionals))

        if (!servers.length)
            servers.push(getDefaultServer({spa: false}))

        for (let i = 0; i < getMaxWorker(global_config); i++) {
            for (const config of servers) {
                startServer(config)
            }
        }
    }
}

try {
    await run()
} catch(err) {
    console.error(err.stack)
}

function loadConfig(parser, file: string) {
    const config = parser.readConfigFile(file, {
        ignoreIncludeErrors: true,
        parseIncludes: true,
    })

    Object.assign(global_config, config)
}

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
            const file_ref: BunFile = file(file_path)
            // console.info('try_files:', { entry, file_path })

            if (await file_ref.exists())
                return new Response(file_ref, { status: HTTP_OK })

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

function refineConfig(argv, [listen, root]) {
    global_config.http.servers = {}
    global_config.http.res_headers = removeToArray(global_config.http, 'add_header')

    Object.defineProperty(global_config, 'cached', {
        enumerable: false,
        writable: false,
        value: {},
    })

    if (listen) {
        const [,, hostname, port] = listen.match(LISTEN_ADDR_RE) || []

        if (root)
            argv.root = root
        else if (!port)
            argv.root = listen

        return global_config.http.servers = { [port]: getDefaultServer(argv, hostname, port) }
    }

    for (const server of removeToArray(global_config.http, 'server')) {
        for (const listen_cfg of toArray(server.listen)) {
            let addr = listen_cfg.split(' ')[0]

            if (Number.isInteger(+addr)) {
                server.port = +addr
                global_config.http.servers[addr] = server
                continue
            }

            const [,, hostname, port] = addr
                .replace('$PORT', Bun.env.PORT)
                .replace('$HOSTNAME', Bun.env.HOSTNAME)
                .match(LISTEN_ADDR_RE)

            server.port = port
            server.hostname = hostname
            global_config.http.servers[server.port] = server
        }

        server.root = server.root?.replaceAll('\\', '/')
        server.res_headers = removeToArray(server, 'add_header')
    }

    return global_config.http.servers
}

function getDefaultServer(argv: object, hostname?: string, port?: number) {
    return {
        port,
        hostname,
        root: (argv.root || process.cwd()).replaceAll('\\', '/'),
        location_actions: {
            '/': [{
                try_files: '$uri $uri/ ' + (argv.spa ? '/index.html' : '=404')
            }]
        }
    }
}

function setResponseHeaders(response: Response, headers: string[]) {
    for (const header of headers || []) {
        const space_pos = header.indexOf(' ')
        response.headers.set(
            header.slice(0, space_pos),
            header.slice(space_pos + 1).replace(/^["']|["']$/g, ''),
        )
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
    server_cfg.location_actions ||= {}

    const server = Bun.serve({
        reusePort: true,
        port: server_cfg.port,
        hostname: server_cfg.hostname,
        maxRequestBodySize: getClientMaxBodySize(global_config),

        async fetch(req: Request, server: Server, response: never) {
            const req_url = new URL(req.url)
            const opts: HandlerOpts = { req, req_url, server, server_cfg }

            for (const [path_prefix, actions] of Object.entries(server_cfg.location_actions)) {
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

    console.info(`Server started on ${getServerAddress(server_cfg, server)}`)
}

function getServerAddress(config, server) {
    if (config.address)
        return config.address

    if (config.hostname)
        return config.address = server.url

    const nets = networkInterfaces()

    for (const interfaces of Object.values(nets)) {
        for (const net_interface of interfaces) {
            if (net_interface.address.startsWith('192.168')) {
                return config.address = `${server.protocol}://${net_interface.address}:${server.port}/`;
            }
        }
    }
}

// console.info(`Child worker (${process.pid}) started`)