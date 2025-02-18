import { expect, it } from "bun:test";
import { $, sleep, spawn } from "bun";
import { parseCLIArgs } from "../utils";


const DEFAULT_CONFIG_FILE = 'config/main/default.conf';

function zerv(args?: string | string[]) {
    args = String(args || '').split(' ')
    const opts = parseCLIArgs(DEFAULT_CONFIG_FILE, args)!
    const proc = spawn(['./zerv.ts', ...args], { stdout: 'pipe', stderr: 'pipe' })

    const stop = (timeout = 0) => sleep(timeout).then(() => proc.kill())

    async function getOutput(): Promise<string> {
        if (proc.stdout) {
            const reader = proc.stdout.getReader()
            return reader.read().then(onRead(reader, ''))
        }
        return '';
    }

    function onRead(reader: any, out: string) {
        return ((chunk: any): any => {
            return chunk.value ? reader.read().then(onRead(reader, out + text(chunk))) : out
        })
    }

    opts.port ||= '3000';

    return {
        stop,
        getOutput,
        pid: proc.pid,
        runWithTimeout(kill_timeout: number) {
            stop(kill_timeout)
            return { getOutput }
        },
        fetch: (url = '') => fetch(`http://localhost:${opts.port}${url}`),
    }
}

const text = (buf: any) => new TextDecoder().decode(buf.value)

it(`should use default config`, async () => {
    function assert(out: any) {
        expect(out).toContain('Welcome to Zerv')
        expect(out).toContain('Server started on 0.0.0.0:3000')
        expect(out).toMatch(/- Local +: http:\/\/127\.0\.0\.1:3000\//)
        expect(out).toMatch(/- Network +: http:\/\/192\.168\.\d+\.\d+:3000\//)
    }

    assert(await zerv().runWithTimeout(100).getOutput())
    assert(await zerv('-c noexist.conf').runWithTimeout(100).getOutput())
})

it(`should use specified port`, async () => {
    const out = await zerv('4000').runWithTimeout(100).getOutput()
    expect(out).toContain('Server started on 0.0.0.0:4000')
    expect(out).toMatch(/- Local +: http:\/\/127\.0\.0\.1:4000\//)
    expect(out).toMatch(/- Network +: http:\/\/192\.168\.\d+\.\d+:4000\//)
})

it(`should not exposed to network`, async () => {
    const out = await zerv('localhost:4000').runWithTimeout(100).getOutput()
    const out2 = await zerv('127.0.0.1:4000').runWithTimeout(100).getOutput()

    expect(out).toContain('Server started on localhost:4000')
    expect(out).toMatch(/- Local +: http:\/\/127\.0\.0\.1:4000\//)
    expect(out).not.toMatch(/- Network +: http:\/\/192\.168\.\d+\.\d+:4000\//)

    expect(out2).toContain('Server started on 127.0.0.1:4000')
    expect(out2).toMatch(/- Local +: http:\/\/127\.0\.0\.1:4000\//)
    expect(out2).not.toMatch(/- Network +: http:\/\/192\.168\.\d+\.\d+:4000\//)
})

it(`should serve current working directory`, async () => {
    const out = await zerv().runWithTimeout(100).getOutput()
    expect(out).toMatch(new RegExp(`- Root +: ${process.cwd()}`))
})

it(`should serve specified directory`, async () => {
    const out = await zerv('testdir').runWithTimeout(100).getOutput()
    expect(out).toMatch(new RegExp(`- Root +: testdir`))
})

it(`should respond with index.html content`, async () => {
    const testdir = `${import.meta.dirname}/server_root_${Bun.randomUUIDv7()}`
    // console.info({testdir})
    await $`mkdir ${testdir}`;
    await $`echo 'hello index' > ${testdir}/index.html`;

    const server = zerv(`${testdir}`)
    await sleep(500).then(async () => {
        const res = await server.fetch()
        expect((await res.text()).trim()).toMatch('hello index')
        expect(res.status).toBe(200)

        server.stop()
        await sleep(200).then(() => $`rm -r ${testdir}`)
    })
})

it(`should respond with status 404 not found`, async () => {
    const testdir = `${import.meta.dirname}/server_root_${Bun.randomUUIDv7()}`
    // console.info({testdir})
    await $`mkdir ${testdir}`;

    const server = zerv(`${testdir}`)
    await sleep(500).then(async () => {
        const res = await server.fetch('/invalid-resource')
        expect(res.status).toBe(404)

        server.stop()
        await sleep(200).then(() => $`rm -r ${testdir}`)
    })
})

it(`should running with SPA mode`, async () => {
    const testdir = `${import.meta.dirname}/server_root_${Bun.randomUUIDv7()}`
    // console.info({testdir})
    await $`mkdir ${testdir}`;
    await $`echo 'heelo SPA' > ${testdir}/index.html`;

    const server = zerv(`${testdir} --spa`)
    await sleep(500).then(async () => {
        const res = await server.fetch('/spa/route')
        expect((await res.text()).trim()).toMatch('heelo SPA')
        expect(res.status).toBe(200)
        await server.stop()
        await sleep(200).then(() => $`rm -r ${testdir}`)
    })
})
