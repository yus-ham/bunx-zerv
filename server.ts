import { watch } from "fs"
import { styleText } from "util"
import { dirname, join } from "path"
import { networkInterfaces } from "os"
import { version } from "./package.json"
import { serve, Server, file, write, $, SocketAddress } from "bun"
import { getClientMaxBodySize, getMaxWorker, toArray, removePropToArray, parseCLIArgs, CLIOptions, getKeepAliveTimeout } from "./utils"
import NginxConfigParser from "@webantic/nginx-config-parser"


const HTTP_SWITCHING_PROTOCOLS = 101
const HTTP_SERVER_ERROR = 500
const HTTP_NOT_FOUND = 404
const HTTP_OK = 200
const LISTEN_ADDR_RE = /((.+):)?(\d+)$/
const DEFAULT_CONFIG_FILE = 'config/main/default.conf'
const global_config: any = {}

Bun.env.NODE_ENV ||= Bun.env.BUN_ENV
const DEV_ENV = Boolean(Bun.env.NODE_ENV) && Bun.env.NODE_ENV?.startsWith('dev')

const gapura = () => styleText(['bold', 'cyan'], 'Welcome to Zerv ') + `(${version})\n`
const inspectHeaders = (hdrs: Headers, compact = true) => Bun.inspect(hdrs, { colors: true, compact, depth: Infinity }).slice(compact ? 12 : 0).replaceAll('\\"', '"')
const timestamp = (d = '') => styleText('blueBright', `[${(d = new Date().toISOString()), d.slice(0, 10)} ${d.slice(11, 23)}]`)

export default async function run() {
    const opts = (await parseCLIArgs(DEFAULT_CONFIG_FILE))!

    if (opts.help) {
        console.info(gapura())
        console.info(`${styleText('yellow', 'Usage:')}\n  zerv [[<hostname>:]<port>] [<directory>] [...options]\n`)
        console.info(styleText('yellow', 'Arguments:'))
        console.info(`  ${styleText('green', 'hostname')}       Host name to be listen on, defaults to ${styleText('green', '0.0.0.0')}`)
        console.info(`  ${styleText('green', 'port')}           Port to be listen on, defaults to ${styleText('green', '3000')}`)
        console.info(`  ${styleText('green', 'directory')}      Root directory to be served at, defaults to current working directory`)
        console.info(styleText('yellow', '\nOptions:'))
        console.info(`  ${styleText('green', '--spa')}                  Enable SPA mode`)
        console.info(`  ${styleText('green', '--cors')}                 Enable CORS mode`)
        console.info(`  ${styleText('green', '-c, --config [<file>]')}  Use config file, defaults to 'config/main/default.conf'`)
        console.info(`  ${styleText('green', '-s, --save')}             Clone default config and save into config file if does not exist`)
        return console.info('')
    }

    let config_file = opts.config
    const parser = new NginxConfigParser()

    if (!await file(config_file).exists())
        config_file = join(import.meta.dirname, DEFAULT_CONFIG_FILE)

    loadConfig(parser, config_file)

    if (opts.cors)
        global_config.cors = true;

    if (DEV_ENV && config_file === DEFAULT_CONFIG_FILE)
        watch('config', { recursive: true }).on('change', () => loadConfig(parser, config_file))

    ensureServers(opts)

    if (opts.save && !await file(opts.config).exists()) {
        const cloned = structuredClone(global_config)

        for (const server of cloned.http.server) {
            delete server.port
            delete server.address
            delete server.hostname
            delete server.location_actions
        }

        await $`mkdir -p ${dirname(opts.config)}`
        await write(opts.config, parser.toConf(cloned))
    }

    console.info(gapura())
    Bun.gc(true)
    startServers()
}

function loadConfig(parser: NginxConfigParser, file: string) {
    try {
        const config = parser.readConfigFile(file, { parseIncludes: true })
        Object.assign(global_config, config)
    } catch (err: any) {
        Bun.env.NODE_ENV === 'test' || console.warn(styleText('yellowBright', err.message))
        const config = parser.readConfigFile(file, { parseIncludes: true, ignoreIncludeErrors: true })
        Object.assign(global_config, config)
    }
}

type Options = {
    req_id: string
    req: Request
    req_url: URL
    server: Server
    server_cfg: any
    path_prefix?: string
    http_version: string
    altered_req_headers?: Headers
    altered_res_headers?: Headers
    client_socket: SocketAddress
}

type HandlerParams = {
    argument: string
    actions: any
}

const location_handlers = {
    async try_files(params: HandlerParams, opts: Options) {
        for (const entry of params.argument.split(' ') || []) {
            if (entry === '=404')
                return new Response(null, { status: HTTP_NOT_FOUND })

            const file_path = opts.server_cfg.root + entry
                .replace('$uri', opts.req_url.pathname)
                .replace(/%[0-9A-Fa-f]{2}/g, (code) => decodeURIComponent(code))

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

    async proxy_pass(params: HandlerParams, opts: Options) {
        opts.altered_req_headers = new Headers()
        const start_time = timestamp()
        let target_url: string | URL = params.argument
        let path_to_append: string = opts.req_url.pathname

        try {

            const should_strip_prefix = target_url.endsWith('/') && (!opts.path_prefix || opts.path_prefix?.endsWith('/'))

            if (should_strip_prefix)
                path_to_append = opts.req_url.pathname.slice(opts.path_prefix?.length ?? 0)

            const base_url_obj = new URL(target_url)
            const final_path = (base_url_obj.pathname + path_to_append).replace(/\/\/+/g, '/')
            target_url = new URL(final_path + opts.req_url.search, target_url)

        } catch (e: any) {
            console.error(e)
            return new Response(`Error constructing proxy URL: ${e.message}`, { status: 500 })
        }

        const data = { target_url }
        if (opts.server.upgrade(opts.req, { data })) {
            return { status: HTTP_SWITCHING_PROTOCOLS } as Response
        }

        opts.req.headers.delete('host')
        opts.req.headers.set('x-forwarded-host', opts.req_url.host)
        opts.req.headers.set('x-forwarded-for', opts.client_socket?.address!)
        opts.req.headers.set('x-forwarded-proto', opts.req_url.protocol.slice(0, -1))
        opts.req.headers.set('x-forwarded-prefix', opts.path_prefix || '')

        for (const header of toArray(params.actions.proxy_set_header)) {
            const [name, value] = parseHeader(header)
            opts.altered_req_headers!.set(name, value)
            opts.req.headers.set(name, value)
        }

        const req_init: RequestInit = {
            headers: opts.req.headers,
            method: opts.req.method,
            body: await opts.req.arrayBuffer(),
            signal: AbortSignal.timeout(parseInt(params.actions.proxy_read_timeout) || 60_000),
            redirect: 'manual',
        }

        
        return fetch(target_url, req_init)
            .then(response => {
                console.info(`${start_time}  > proxy_pass:`, opts.req.method, String(target_url), `HTTP/${opts.http_version} | altered headers`, inspectHeaders(opts.altered_req_headers!))
                console.info(`${timestamp()}  < proxy_pass: HTTP/${opts.http_version}`, response.status, response.statusText, inspectHeaders(response.headers))

                const contentEncoding = response.headers.get('content-encoding')
                if (contentEncoding && ['gzip', 'zstd'].includes(contentEncoding))
                    response.headers.delete('content-encoding')

                return response
            })
    },

    async proxy_http_version() { },
    async proxy_cache_bypass() { },
}

async function runActions(actions: any, opts: Options): Promise<Response | undefined> {

    if (global_config.cors) {
        const origin = opts.req.headers.get('origin')

        if (origin) {
            actions.add_header ||= []
            actions.add_header.push(`access-control-allow-origin ${origin}`)

            if (!actions.add_header.some((n: string) => n.startsWith('access-control-allow-headers'))) {
                actions.add_header.push(`access-control-allow-headers ${opts.req.headers.get('access-control-request-headers') || ''}`)
            }
            if (!actions.add_header.some((n: string) => n.startsWith('access-control-allow-methods'))) {
                actions.add_header.push(`access-control-allow-methods GET, POST, OPTIONS`)
            }
        }
    }

    if (opts.req.method === 'OPTIONS' && opts.req.headers.has('access-control-request-method')) {
        const options_actions = actions[`if ($request_method = 'OPTIONS')`]
        if (options_actions) {
            const response = withHeaders(new Response(null, { status: parseInt(options_actions.return) || 204 }), options_actions, opts)
            const origin = response.headers.get('access-control-allow-origin')
            const methods = response.headers.get('access-control-allow-methods')
            const headers = response.headers.get('access-control-allow-headers')

            if (origin?.[0] === '*')
                response.headers.set('access-control-allow-origin', '*')

            if (methods)
                response.headers.set('access-control-allow-methods', methods.replace(/['"] always/, ''))

            if (headers)
                response.headers.set('access-control-allow-headers', headers.replace(/['"] always/, ''))

            return response
        }

        return withHeaders(new Response(null, { status: 200 }), actions, opts)
    }

    for (const [action, argument] of Object.entries(actions)) { // @ts-ignore
        const response = await location_handlers[action]?.({ argument, actions }, opts)
        if (response?.status >= 200) {
            return withHeaders(response, actions, opts)
        }
    }
}

function withHeaders(response: Response, actions: any, opts: Options) {
    opts.altered_res_headers = new Headers()
    setResponseHeaders(response, global_config.http.add_header, opts)
    setResponseHeaders(response, opts.server_cfg.add_header, opts)
    setResponseHeaders(response, actions.add_header, opts)

    console.info(`${timestamp()} < HTTP/${opts.http_version} ${response.status} ${response.statusText} | altered headers`, inspectHeaders(opts.altered_res_headers))
    return response
}

const multi_value_headers = [
    'cache-control',
    'accept-ranges',
    'content-encoding',
    'www-authenticate',
    'warning',
    'allow',
    'vary',
    'link',
]

function parseHeader(header: string) {
    const space_pos = header.indexOf(' ')
    const name = header.slice(0, space_pos).toLowerCase().replace(/^["']|["']$/g, '')
    const value = header.slice(space_pos + 1).replace(/^["']|["']$/g, '')
    return [name, value]
}

function setResponseHeaders(response: Response, headers: string[], opts: Options) {
    for (const header of headers || []) {
        let [name, value] = parseHeader(header)

        multi_value_headers.includes(name)
            ? response.headers.append(name, value)
            : response.headers.set(name, value)

        opts.altered_res_headers!.append(name, value)
    }
}

function ensureServers(opts: CLIOptions) {
    global_config.http.add_header = toArray(global_config.http.add_header)

    Object.defineProperty(global_config, 'cached', {
        enumerable: false,
        writable: false,
        value: {},
    })

    const processed_servers: any = {}

    for (const server of toArray(global_config.http.server)) {
        let has_explicit_listen = false
        let determined_port = null

        for (const listen_cfg of toArray(server.listen)) {
            has_explicit_listen = true
            let addr = listen_cfg.split(' ')[0]

            if (Number.isInteger(+addr)) {
                determined_port = +addr
            } else {
                const [, , hostname, port] = addr.match(LISTEN_ADDR_RE)
                determined_port = port
                server.hostname = hostname // Update server's hostname
                if (hostname === '[::]')
                    server.family = 'IPv6'
            }

        }

        if (!has_explicit_listen) {
            if (server.ssl || server.ssl_certificate) {
                determined_port = 443
            }
            else {
                determined_port = 80
            }
        }

        if (opts.port) {
            server.port = opts.port
        } else if (determined_port !== null) {
            server.port = determined_port
        }

        server.add_header = toArray(server.add_header)
        server.index = server.index.split(' ')
        setupLocationActions(server)

        processed_servers[server.port] ||= []
        processed_servers[server.port].push(server)
    }

    global_config.http.server = Object.values(processed_servers)

    if (!global_config.http.server.length) {
        const defaultServer = getDefaultServer(opts)
        setupLocationActions(defaultServer)
        global_config.http.server.push([defaultServer])
    }
}

function getDefaultServer(opts: CLIOptions) {
    return {
        ...opts,
        index: ['index.html'],
        'location /': { try_files: '$uri $uri/ ' + (opts.spa ? '/index.html' : '=404') },
    }
}

function onWscOpen(wsc: WebSocket, callback: Function) {
    setTimeout(() => {
        wsc.readyState === wsc.OPEN
            ? callback(wsc)
            : onWscOpen(wsc, callback)
    }, 10)
}

function startServers() {
    const workers_num = getMaxWorker(global_config)

    for (let i = 1; i <= workers_num; i++) {
        for (const config of global_config.http.server)
            startServer(config, workers_num, i === workers_num)
    }
}

function startServer(server_cfg: any, workers_num: number, print_log = false) {
    server_cfg = server_cfg[0]
    const server = serve({
        reusePort: true,
        development: DEV_ENV,
        port: server_cfg.port,
        hostname: server_cfg.hostname,
        idleTimeout: getKeepAliveTimeout(global_config),
        maxRequestBodySize: getClientMaxBodySize(global_config),

        async fetch(req: Request, server: Server) {
            const client_socket = server.requestIP(req)!
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
            const opts: Options = {
                http_version: '1.1',
                req_id: Bun.randomUUIDv7(),
                req,
                req_url,
                server,
                server_cfg,
                client_socket,
            }

            
            for (const [path_prefix, actions] of Object.entries(server_cfg.location_actions)) {
                
                if (req_url.pathname.startsWith(path_prefix)) {
                    opts.path_prefix = path_prefix
                    return runActions(actions, opts)
                }
            }


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

    process.send?.({ http: { port: server.port } })
    setServerAddress(server_cfg, server)
    print_log && printServerInfo(server_cfg, workers_num)
}

function setupLocationActions(server_cfg: any) {
    server_cfg.location_actions ||= {}

    for (const [directive, config] of Object.entries(server_cfg)) {
        try {
            if (directive.startsWith('location ')) {
                const location_actions: any = {}
                const actions_cfg = toArray(config)

                server_cfg.location_actions[directive.slice(9)] = location_actions
                location_actions.add_header = []

                for (let actions of actions_cfg) {
                    actions = { ...actions }
                    location_actions.add_header.push(...removePropToArray(actions, 'add_header'))
                    Object.assign(location_actions, actions)
                }
            }
        } catch (e) {
            console.error("Error parsing location directive:", e)
        }
    }

   const sorted_entries = Object.entries(server_cfg.location_actions).sort((a, b) => b[0].length - a[0].length)
   server_cfg.location_actions = Object.fromEntries(sorted_entries)
}

function errorResponse(e: any, opts: Options) {
    if (e.code === 'ConnectionRefused')
        e.message = `Unable to connect to upstream server` + (DEV_ENV ? ` ${e.path}` : ``)
    else if (!e.code)
        e.code = 'ServerError'

    return new Response(`${e.code}: ${e.message}\nRequest ID: ${opts.req_id}`, { status: HTTP_SERVER_ERROR })
}

function printServerInfo(config: any, workers_num: number) {
    console.info(styleText('green', `Server started on ${config.hostname}:${config.port} with ${workers_num} workers`))
    console.info(styleText('green', `    - Local     : http://127.0.0.1:${config.port}/`))

    if (!['localhost', '127.0.0.1'].includes(config.hostname))
        console.info(styleText('green', `    - Network   : ${config.address}`))

    console.info(styleText('green', `    - Root      : ${config.root}`))
}

function setServerAddress(config: any, server: Server) {
    config.port = server.port

    if (config.address)
        return config.address

    if (config.hostname)
        return config.address = server.url

    config.hostname = '0.0.0.0'
    const nets = networkInterfaces() || []

    for (const interfaces of Object.values(nets)) {
        for (const net_interface of interfaces || []) {
            if (net_interface.address.startsWith('192.168')) {
                // @ts-ignore
                return config.address = `${server.protocol}://${net_interface.address}:${server.port}/`
            }
        }
    }
}