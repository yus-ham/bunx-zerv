import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $, Server, serve, sleep, spawn } from "bun";
import { parseCLIArgs } from "../utils";


const DEFAULT_CONFIG_FILE = 'config/main/default.conf';

type Zerv = {
    stop: Function;
    fetch: Function;
}

function parseZervProcess(proc: any, opts: any) {
    async function getOutput(): Promise<string> {
        if (proc.stdout) {
            const reader = proc.stdout.getReader()
            const output = await reader.read().then(onRead(reader, ''))
            return Bun.stripANSI(output)
        }
        return '';
    }

    function onRead(reader: any, out: string) {
        return ((chunk: any): any => chunk.value ? reader.read().then(onRead(reader, out + text(chunk))) : out)
    }

    const stop = (timeout = 0) => sleep(timeout).then(() => proc.kill())

    return {
        stop,
        getOutput,
        pid: proc.pid,
        get port() { return opts.port },
        runWithTimeout(kill_timeout: number) {
            stop(kill_timeout)
            return {
                getOutput,
                get port() { return opts.port },
            }
        },
        fetch: (path = '', headers = {}) => fetch(`http://localhost:${opts.port}${path}`, { headers }),
    }
}

function zerv(args?: string | string[], opts = {}, env?: Record<string, string>) {
    args = String(args || '').split(' ')
    opts = { ...opts }

    parseCLIArgs(DEFAULT_CONFIG_FILE, args).then((res) => Object.assign(opts, res))

    const proc = spawn(['bun', './zerv.ts', ...args], {
        ...(process.env.TESTV == '2' ? {
            stdout: 'inherit',
            stderr: 'inherit',
        } : {
            stdout: 'pipe',
        }),
        ipc(message) {
            if (opts.port === 0)
                opts.port = message.http.port
        },
        env: { ...process.env, ...env },
    })

    return parseZervProcess(proc, opts)
}


const text = (buf: any) => new TextDecoder().decode(buf.value)
const getRandomPort = () => Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152;

describe('starting server', () => {
    it(`should use default config`, async () => {
        function assert(output: any, port: number) {
            expect(output).toContain('Welcome to Zerv')
            expect(output).toContain(`Server started on 0.0.0.0:${port}`)
            expect(output).toMatch(new RegExp(`- Local +: http://127\\.0\\.0\\.1:${port}/`))
            expect(output).toMatch(new RegExp(`- Network +: http://192\\.168\\.\\d+\\.\\d+:${port}/`))
        }

        const randomPort = getRandomPort();
        const server = zerv('', {}, { PORT: String(randomPort) }).runWithTimeout(476)
        const out = await server.getOutput()
        assert(out, randomPort)

        const randomPort2 = getRandomPort();
        const server2 = zerv('-c noexist.conf', {}, { PORT: String(randomPort2) }).runWithTimeout(476)
        const out2 = await server2.getOutput()
        assert(out2, randomPort2)
    })

    it(`should use specified port`, async () => {
        const out = await zerv('45678').runWithTimeout(476).getOutput()
        expect(out).toContain('Server started on 0.0.0.0:45678')
        expect(out).toMatch(/- Local +: http:\/\/127\.0\.0\.1:45678\//)
        expect(out).toMatch(/- Network +: http:\/\/192\.168\.\d+\.\d+:45678\//)
    })

    it(`should use random port`, async () => {
        const server = zerv('0').runWithTimeout(476)
        const out = await server.getOutput()
        expect(out).toContain(`Server started on 0.0.0.0:${server.port}`)
    })

    it(`should only exposed to local network`, async () => {
        let server = zerv('localhost:0').runWithTimeout(476)
        let server1 = zerv('127.0.0.1:0').runWithTimeout(476)
        const out = await server.getOutput()
        const out1 = await server1.getOutput()

        expect(out).toContain(`Server started on localhost:${server.port}`)
        expect(out).toMatch(new RegExp(`- Local +: http://127\\.0\\.0\\.1:${server.port}/`))
        expect(out).not.toMatch(new RegExp(`- Network +: http://192\\.168\\.\\d+\\.\\d+:${server.port}/`))

        expect(out1).toContain(`Server started on 127.0.0.1:${server1.port}`)
        expect(out1).toMatch(new RegExp(`- Local +: http://127\\.0\\.0\\.1:${server1.port}/`))
        expect(out1).not.toMatch(new RegExp(`- Network +: http://192\\.168\\.\\d+\\.\\\d+:${server1.port}/`))
    })

    it(`should serve current working directory`, async () => {
        const out = await zerv('0').runWithTimeout(476).getOutput()
        expect(out).toMatch(new RegExp(`- Root +: ${process.cwd().replaceAll('\\', '/')}`))
    })

    it(`should serve specified directory`, async () => {
        const testdir = `${import.meta.dirname}/server_root-${Bun.randomUUIDv7()}`;
        await $`mkdir ${testdir}`;
        const out = await zerv(`0 ${testdir}`).runWithTimeout(476).getOutput()
        expect(out).toMatch(new RegExp(`- Root +: ${testdir}`))
        await $`rm -r ${testdir}`;
    })
})

describe('try_files', () => {
    it(`should respond with index.html content`, async () => {
        const testdir = `${import.meta.dirname}/server_root-${Bun.randomUUIDv7()}`;
        await $`mkdir ${testdir}`;
        await $`echo 'hello index' > ${testdir}/index.html`;

        const server = zerv(`0 ${testdir}`)
        await sleep(476)
        const res = await server.fetch()
        const res2 = await server.fetch('/index.html')

        expect((await res.text()).trim()).toMatch('hello index')
        expect((await res2.text()).trim()).toMatch('hello index')
        expect(res.status).toBe(200)

        server.stop()
        await sleep(50)
        await $`rm -r ${testdir}`;
    })

    it(`should respond with status 404 not found`, async () => {
        const testdir = `${import.meta.dirname}/server_root-${Bun.randomUUIDv7()}`
        await $`mkdir ${testdir}`;

        const server = zerv(`0 ${testdir}`)
        await sleep(476)
        const res = await server.fetch('/invalid-resource')
        expect(res.status).toBe(404)

        server.stop()
        await sleep(50)
        await $`rm -r ${testdir}`;
    })

    it(`should running with SPA mode`, async () => {
        const testdir = `${import.meta.dirname}/server_root-${Bun.randomUUIDv7()}`
        await $`mkdir ${testdir}`;
        await $`echo 'heelo SPA' > ${testdir}/index.html`;

        const server = zerv(`0 ${testdir} --spa`)
        await sleep(476)
        const res = await server.fetch('/spa/route')

        expect((await res.text()).trim()).toMatch('heelo SPA')
        expect(res.status).toBe(200)

        await server.stop()
        await sleep(50)
        await $`rm -r ${testdir}`;
    })
})

describe('cors', () => {
    it(`should respond with cors enabled`, async () => {
        const origin = 'http://cross.domain';
        const server = zerv(`0 --cors`)
        await sleep(476)
        const res = await server.fetch('/', { origin })
        expect(res.headers.get('access-control-allow-origin')).toBe(origin)
    })
})

describe('proxy_pass', () => {
    let testdir, server: Zerv, upstream: Server

    beforeEach(() => {
        testdir = `${import.meta.dirname}/server_root_upstream`
        server = zerv(`23456 -c ${testdir}/server.conf`)
        upstream = serve({
            reusePort: true,
            port: 23455,
            routes: { '/404/*': new Response('', { status: 404 }) },
            fetch: (req) => {
                const url = new URL(req.url)
                return new Response(JSON.stringify({
                    upstream_req: {
                        url: {
                            pathname: url.pathname
                        },
                        headers: req.headers,
                    }
                }))
            },
        })
        return sleep(476)
    })

    afterEach(async () => {
        await upstream.stop(true)
        return server.stop()
    })

    it(`should forward request to and get response from upstream`, async () => {
        const res = await server.fetch('/upstream/index.html')
        const res1 = await server.fetch('/upstream/404/not/found')
        const res2 = await server.fetch('/upstream-123-qwe')
        const res3 = await server.fetch('/upstream-asd-123')
        const res4 = await server.fetch('/upstream-asd')
        const res5 = await server.fetch('/upstream-asd-handled-by/upstream-asd')
        const res_c = await server.fetch('/scenario-c/page.html')
        const res_5 = await server.fetch('/scenario-5/page.html')
        const upstream_req = (await res.json()).upstream_req

        expect(res.status).toBe(200)
        expect(res1.status).toBe(404)
        expect(res2.status).toBe(200)
        expect(res3.status).toBe(200)
        expect(res4.status).toBe(200)
        expect(res5.status).toBe(200)
        expect(res_c.status).toBe(200)
        expect(res_5.status).toBe(200)
        expect(upstream_req.headers['x-forwarded-proto']).toBe('http')
        expect(upstream_req.headers['x-forwarded-host']).toBe('localhost:23456')
        expect(upstream_req.headers['x-forwarded-for']).toMatch(/127\.0\.0\.1|::1/)
        expect(upstream_req.url.pathname).toMatch('/index.html')
        expect((await res3.json()).upstream_req.url.pathname).toMatch('/')
        expect((await res4.json()).upstream_req.url.pathname).toMatch('/')
        expect((await res_c.json()).upstream_req.url.pathname).toBe('/prefix-c/page.html')
        expect((await res_5.json()).upstream_req.url.pathname).toBe('/prefix-5/scenario-5/page.html')
    })

    it(`should set specified header to upstream`, async () => {
        const res = await server.fetch('/upstream/index.html')
        expect((await res.json()).upstream_req.headers['x-my-header']).not.toBeEmpty()
    })
})
