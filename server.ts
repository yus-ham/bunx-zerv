import { watch } from "fs"
import { dirname, join } from "path"
import { networkInterfaces } from "os"
import { parseArgs, styleText } from "util"
import { serve, Server, file, write, $ } from "bun"
import { getClientMaxBodySize, getMaxWorker, toArray } from "./utils"
import NginxConfigParser from "@webantic/nginx-config-parser"


const HTTP_SWITCHING_PROTOCOLS = 101
const HTTP_NOT_FOUND = 404
const HTTP_OK = 200
const LISTEN_ADDR_RE = /((.+):)?(\d+)$/
const DEFAULT_CONFIG_FILE = 'config/main/default.conf'
const global_config = {}

Bun.env.NODE_ENV ||= Bun.env.BUN_ENV
const DEV_ENV = Boolean(Bun.env.NODE_ENV) && Bun.env.NODE_ENV?.startsWith('dev')

function parseCLIArgs() {
    try {
        return parseArgs({
            allowPositionals: true,
            options: {
                help: { type: 'boolean', short: 'h' },
                config: { type: 'string', short: 'c', default: DEFAULT_CONFIG_FILE },
                save: { type: 'boolean', short: 's' },
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

export default async function run() {
    const { values: argv, positionals } = parseCLIArgs()

    if (argv?.help) {
        console.info(`${styleText('yellow', 'Usage:')}\n  zerv [[hostname:]port] [directory] [options]\n`)
        console.info(styleText('yellow', 'Arguments:'))
        console.info(`  ${styleText('green', 'hostname')}       Host name to be listen on, defaults to ${styleText('green', '0.0.0.0')}`)
        console.info(`  ${styleText('green', 'port')}           Port to be listen on, defaults to ${styleText('green', '3000')}`)
        console.info(`  ${styleText('green', 'directory')}      Root directory to be served at, defaults to current working directory`)
        console.info(styleText('yellow', '\nOptions:'))
        console.info(`  ${styleText('green', '--spa')}                  Enable SPA mode`)
        console.info(`  ${styleText('green', '-c, --config <file>')}    Use config file`)
        console.info(`  ${styleText('green', '-s, --save')}             Clone default config and save into config file if does not exist`)
        return console.info('')
    }

    if (argv) {
        let config_file = argv.config
        const parser = new NginxConfigParser()

        if (!await file(config_file).exists())
            config_file = join(import.meta.dirname, DEFAULT_CONFIG_FILE)

        loadConfig(parser, config_file)

        if (DEV_ENV && config_file === DEFAULT_CONFIG_FILE)
            watch('config', { recursive: true }).on('change', () => loadConfig(parser, config_file))

        ensureServers(argv, positionals)

        if (argv.save && !await file(argv.config).exists()) {
            const cloned = structuredClone(global_config)
            
            for (const server of cloned.http.server) {
                delete server.port
                delete server.address
                delete server.hostname
                delete server.location_actions
            }

            await $`mkdir -p ${dirname(argv.config)}`;
            await write(argv.config, parser.toConf(cloned))
        }

        Bun.gc(true)
        startServers()
    }
}

function loadConfig(parser: NginxConfigParser, file: string) {
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
            // console.info('try_files:', entry)

            if (entry === '=404')
                return new Response(null, { status: HTTP_NOT_FOUND })

            const file_path = opts.server_cfg.root + entry.replace('$uri', opts.req_url.pathname)

            if (entry.endsWith('/')) {
                for (const index of opts.server_cfg.index) {
                    const file_ref = file(file_path + index)
                    if (await file_ref.exists())
                        return new Response(file_ref, { status: HTTP_OK })
                }
                continue
            }

            const file_ref = file(file_path)

            if (await file_ref.exists())
                return new Response(file_ref, { status: HTTP_OK })
        }
    },

    async proxy_pass(target_url: string, opts: HandlerOpts) {
        //console.info('proxy_pass:', target_url)

        target_url = target_url + opts.req_url.pathname.slice(opts.path_prefix?.length!) + opts.req_url.search

        //console.info('proxy_pass:', {altered_target_url: target_url})

        if (opts.path_prefix && !opts.req_url.pathname.startsWith(opts.path_prefix)) {
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
            setResponseHeaders(response, global_config.http.add_header)
            setResponseHeaders(response, opts.server_cfg.add_header)
            setResponseHeaders(response, actions.add_header)
            return response
        }
    }
}

function ensureServers(argv, [listen, root]) {
    global_config.http.add_header = toArray(global_config.http.add_header)

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

        return global_config.http.server = [ getDefaultServer(argv, hostname, port) ]
    }

    const servers: Record<string, object> = {}

    for (const server of toArray(global_config.http.server)) {
        for (const listen_cfg of toArray(server.listen)) {
            let addr = listen_cfg.split(' ')[0]

            if (Number.isInteger(+addr)) {
                server.port = +addr
                servers[addr] = server
                continue
            }

            const [,, hostname, port] = addr
                .replace('$PORT', Bun.env.PORT)
                .replace('$HOSTNAME', Bun.env.HOSTNAME)
                .match(LISTEN_ADDR_RE)

            server.port = port
            server.hostname = hostname
            servers[server.port] = server
        }

        server.root = server.root?.replaceAll('\\', '/')
        server.add_header = toArray(server.add_header)
        server.index = server.index.split(' ')
    }

    global_config.http.server = Object.values(servers)

    if (!global_config.http.server.length)
        global_config.http.server.push(getDefaultServer({spa: false}))
}

function getDefaultServer(argv: object, hostname?: string, port?: number) {
    return {
        port,
        hostname,
        index: ['index.html'],
        root: (argv.root || process.cwd()).replaceAll('\\', '/'),
        'location /': { try_files: '$uri $uri/ ' + (argv.spa ? '/index.html' : '=404') },
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

function startServers(config?: any) {
    const workers_num = getMaxWorker(global_config)

    for (let i = 1; i <= workers_num; i++) {
        for (config of global_config.http.server) {
            startServer(config as object)
        }

        if (i === workers_num) {
            let out = `Server started on ${config.hostname}:${config.port} with ${workers_num} workers`;
            out += `\n    - Local     : http://127.0.0.1:${config.port}/`;

            if (config.hostname === '0.0.0.0')
                out += `\n    - Network   : ${config.address}`;

            console.info(styleText('green', out))
        }
    }
}

function startServer(server_cfg: object) {
    server_cfg.location_actions ||= {}

    const server = serve({
        reusePort: true,
        development: DEV_ENV,
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
                    location_actions.add_header = []

                    for (const actions of actions_cfg) {
                        location_actions.add_header.push(...toArray(actions.add_header))
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
                // @ts-ignore
                wss.upstream_wsc = new WebSocket(wss.data.target_url)
                // @ts-ignore
                wss.upstream_wsc.addEventListener('message', (e) => {
                    wss.send(e.data)
                })
            },
            message(wss, message) {
                // @ts-ignore
                onWscOpen(wss.upstream_wsc, (wsc: WebSocket) => {
                    wsc.send(message)
                })
            }
        },
        error(e) {
            if (e.name === 'ConnectionRefused')
                return new Response(`Upstream error: ${e.message} ${e.path}`, { status: 500 })
        },
    })

    setServerAddress(server_cfg, server)
}

function setServerAddress(config: object, server: Server) {
    config.port ||= server.port;

    if (config.address)
        return config.address

    if (config.hostname)
        return config.address = server.url

    config.hostname = '0.0.0.0';
    const nets = networkInterfaces() || []

    for (const interfaces of Object.values(nets)) {
        for (const net_interface of interfaces || []) {
            if (net_interface.address.startsWith('192.168')) {
                    // @ts-ignore
                    return config.address = `${server.protocol}://${net_interface.address}:${server.port}/`;
            }
        }
    }
}