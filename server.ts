import { watch } from "fs"
import { styleText } from "util"
import { dirname, join } from "path"
import { networkInterfaces } from "os"
import { version } from "./package.json"
import { serve, Server, file, write, $ } from "bun"
import { getClientMaxBodySize, getMaxWorker, toArray, removePropToArray, parseCLIArgs } from "./utils"
import NginxConfigParser from "@webantic/nginx-config-parser"


const HTTP_SWITCHING_PROTOCOLS = 101
const HTTP_NOT_FOUND = 404
const HTTP_OK = 200
const LISTEN_ADDR_RE = /((.+):)?(\d+)$/
const DEFAULT_CONFIG_FILE = 'config/main/default.conf'
const global_config: any = {}

Bun.env.NODE_ENV ||= Bun.env.BUN_ENV
const DEV_ENV = Boolean(Bun.env.NODE_ENV) && Bun.env.NODE_ENV?.startsWith('dev')

const gapura = () => styleText(['bold', 'cyan'], 'Welcome to Zerv ') + `(${version})\n`;
const inspectHeaders = (hdrs: Headers) => Bun.inspect(hdrs, {colors: true, compact: true}).slice(12).replaceAll('\\"', '"')
const timestamp = (d = '') => styleText('blueBright', `[${(d = new Date().toISOString()), d.slice(0, 10)} ${d.slice(11, 23)}]`)

export default async function run() {
    const { values: argv, positionals } = parseCLIArgs(DEFAULT_CONFIG_FILE)!

    if (argv?.help) {
        console.info(gapura())
        console.info(`${styleText('yellow', 'Usage:')}\n  zerv [[<hostname>:]<port>] [<directory>] [...options]\n`)
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

        console.info(gapura())
        Bun.gc(true)
        startServers()
    }
}

function loadConfig(parser: NginxConfigParser, file: string) {
    try {
        const config = parser.readConfigFile(file, { parseIncludes: true })
        Object.assign(global_config, config)
    } catch(err: any) {
        console.error(err.message)
        const config = parser.readConfigFile(file, { parseIncludes: true, ignoreIncludeErrors: true })
        Object.assign(global_config, config)
    }
    //console.info(Bun.inspect(global_config, {colors:true, depth:Infinity}))
}

type HandlerOpts = {
    req_id: string;
    req: Request;
    req_url: URL;
    server: Server;
    server_cfg: any;
    path_prefix?: string;
    altered_headers?: Headers;
}

const location_handlers = {
    async try_files(files: string, opts: HandlerOpts) {
        for (const entry of files?.split(' ') || []) {
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
        target_url = target_url + opts.req_url.pathname.slice(opts.path_prefix?.length!) + opts.req_url.search

        if (opts.path_prefix && !opts.req_url.pathname.startsWith(opts.path_prefix)) {
            return
        }

        const data = { target_url }
        if (opts.server.upgrade(opts.req, { data })) {
            return { status: HTTP_SWITCHING_PROTOCOLS } as Response
        }

        opts.req.headers.delete('host')

        const req_init: RequestInit = {
            headers: opts.req.headers,
            method: opts.req.method,
            body: await opts.req.arrayBuffer(),
        }

        const start_time = timestamp()

        return fetch(target_url, req_init)
            .then(response => {
                console.info(`${start_time}  proxy_pass >`, opts.req.method, target_url, 'HTTP/1.1')
                console.info(`${timestamp()}  < HTTP/1.1`, response.status, response.statusText, inspectHeaders(response.headers))
                return response
            })
    },

    async proxy_http_version() { },
    async proxy_set_header() { },
    async proxy_cache_bypass() { },
}

async function runActions(actions: any, opts: HandlerOpts): Promise<Response|undefined> {
    if (opts.req.method === 'OPTIONS' && opts.req.headers.has('access-control-request-method')) {
        return withHeaders(new Response(null, { status: 200 }), opts, actions)
    }

    for (const [action, argument] of Object.entries(actions)) { // @ts-ignore
        const response = await location_handlers[action]?.(argument, opts)
        if (response?.status >= 200) {
            return withHeaders(response, opts, actions)
        }
    }
}

function withHeaders(response: Response, opts: HandlerOpts, actions: any) {
    opts.altered_headers = new Headers()
    setResponseHeaders(response, global_config.http.add_header, opts)
    setResponseHeaders(response, opts.server_cfg.add_header, opts)
    setResponseHeaders(response, actions.add_header, opts)
    console.info(`${timestamp()} < HTTP/1.1 ${response.status} ${response.statusText} | altered headers`, inspectHeaders(opts.altered_headers))
    return response
}

function setResponseHeaders(response: Response, headers: string[], opts: HandlerOpts) {
    for (const header of headers || []) {
        const space_pos = header.indexOf(' ')
        const name = header.slice(0, space_pos).toLowerCase()
        let value = header.slice(space_pos + 1).replace(/^["']|["']$/g, '')

        if (name.startsWith('access-control'))
            value = value.replace(' always', '')

        if (name.endsWith('allow-headers')) {
            value = value.replace('$http_access_control_request_headers', opts.req.headers.get('access-control-request-headers') || '')
            if (!value)
                continue
        }

        response.headers.append(name, value)
        opts.altered_headers!.append(name, value)
    }
}
function ensureServers(argv: any, [listen, root]: string[]) {
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
        else if (!port && port !== '0')
            argv.root = listen

        return global_config.http.server = [ getDefaultServer(argv, hostname, port) ]
    }

    const servers: Record<string, any> = {}

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

            servers[server.port] ||= { port, family: 'IPv4' }
            servers[server.port].port ||= port

            if (hostname === '[::]')
                servers[server.port].family = 'IPv6'
        }

        server.root = server.root?.replaceAll('\\', '/')
        server.add_header = toArray(server.add_header)
        server.index = server.index.split(' ')
    }

    global_config.http.server = Object.values(servers)

    if (!global_config.http.server.length)
        global_config.http.server.push(getDefaultServer())
}

function getDefaultServer(argv: any = {}, hostname?: string, port?: any) {
    return {
        port,
        hostname,
        index: ['index.html'],
        root: (argv.root || process.cwd()).replaceAll('\\', '/'),
        'location /': { try_files: '$uri $uri/ ' + (argv.spa ? '/index.html' : '=404') },
    }
}

function onWscOpen(wsc: WebSocket, callback: Function) {
    setTimeout(() => {
        wsc.readyState === wsc.OPEN
            ? callback(wsc)
            : onWscOpen(wsc, callback)
    }, 10)
}

function startServers(config?: any) {
    const workers_num = getMaxWorker(global_config)

    for (let i = 1; i <= workers_num; i++) {
        for (config of global_config.http.server)
            startServer(config as object, workers_num, i === workers_num)
    }
}

function startServer(server_cfg: any, workers_num: number, print_log = false) {
    server_cfg.location_actions ||= {}

    const server = serve({
        reusePort: true,
        development: DEV_ENV,
        port: server_cfg.port,
        hostname: server_cfg.hostname,
        maxRequestBodySize: getClientMaxBodySize(global_config),

        async fetch(req: Request, server: Server) {
            const client_socket = server.requestIP(req)
            const origin_address = req.headers.get('x-forwarded-for')

            console.info(
                timestamp(),
                origin_address ? origin_address + ' > ' : '',
                `${client_socket?.address}:${client_socket?.port} >`,
                req.method,
                req.url,
                inspectHeaders(req.headers),
            )

            const req_url = new URL(req.url)
            const opts: HandlerOpts = {
                req_id: Bun.randomUUIDv7(),
                req,
                req_url,
                server,
                server_cfg,
            }

            req.headers.set('x-forwarded-for', client_socket?.address!)
            req.headers.set('x-forwarded-host', req_url.host)
            req.headers.set('x-forwarded-proto', req_url.protocol)

            for (const [path_prefix, actions] of Object.entries(server_cfg.location_actions)) {
                if (req_url.pathname.startsWith(path_prefix)) {
                    opts.path_prefix = path_prefix
                    return runActions(actions, opts).catch(e => catchUpstreamError(e, opts))
                }
            }

            for (const [directive, config] of Object.entries(server_cfg)) {
                try {
                    if (directive.startsWith('location ')) {
                        const location_actions: any = {}
                        const actions_cfg = toArray(config)

                        server_cfg.location_actions[opts.path_prefix = directive.slice(9)] = location_actions
                        location_actions.add_header = []

                        for (let actions of actions_cfg) {
                            actions = { ...actions }
                            location_actions.add_header.push(...removePropToArray(actions, 'add_header'))
                            Object.assign(location_actions, actions)
                        }

                        const response = await runActions(location_actions, opts)
                        if (response)
                            return response
                    }
                } catch(e) {
                    if (e = catchUpstreamError(e, opts))
                        return e as Response
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
    })

    setServerAddress(server_cfg, server)
    print_log && printServerInfo(server_cfg, workers_num)
}

function catchUpstreamError(e: any, opts: HandlerOpts) {
    console.error(e)
    if (e.code === 'ConnectionRefused')
        e.message = `Unable to connect to upstream server` + (DEV_ENV ? ` ${e.path}` : ``)
    return new Response(`${e.code}: ${e.message}\nRequest ID: ${opts.req_id}`, { status: 500 })
}

function printServerInfo(config: any, workers_num: number) {
    console.info(styleText('green', `Server started on ${config.hostname}:${config.port} with ${workers_num} workers`))
    console.info(styleText('green', `    - Local     : http://127.0.0.1:${config.port}/`))

    if (config.hostname === '0.0.0.0')
        console.info(styleText('green', `    - Network   : ${config.address}`))
}

function setServerAddress(config: any, server: Server) {
    if (!config.port && config.port != 0)
        config.port = server.port

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