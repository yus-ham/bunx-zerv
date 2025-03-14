import { parseArgs } from "util";

const BYTE_UNITS = 'KMGTPEZY';
const LISTEN_ADDR_RE = /^((.+):)?(\d+)$/

export function toArray(data: any) {
    return Array.isArray(data) ? data : (data ? [data] : [])
}

export function removeProp(data: Record<string, any>, key: string) {
    const value = data[key]
    delete data[key]
    return value
}

export function removePropToArray(data: object, key: string) {
    return toArray(removeProp(data, key))
}

export type CLIOptions = {
    help: boolean;
    config: string;
    save: boolean;
    spa: boolean;
    root: string;
    port: string;
    hostname: string;
}

export function parseCLIArgs(config_file: string, args?: string[]) {
    try {
        const { values, positionals: [listen, root]} = parseArgs({
            allowPositionals: true,
            options: {
                help: { type: 'boolean', short: 'h' },
                config: { type: 'string', short: 'c', default: config_file },
                save: { type: 'boolean', short: 's' },
                spa: { type: 'boolean' },
            },
            ...(args ? {args} : {}),
        }) as never as {values: CLIOptions; positionals: any}

        const matches = listen?.match(LISTEN_ADDR_RE) || []
        values.hostname = matches[2]
        values.port = matches[3]

        if (root)
            values.root = root
        else if (!values.port && values.port !== '0')
            values.root = listen

        values.root = (values.root || process.cwd()).replaceAll('\\', '/')

        return values
    } catch(err: any) {
        if (err.message.startsWith('Unexpected argument'))
            return console.error(err.message.slice(0, err.message.indexOf("'. ") + 1))
        let matches
        if (matches = err.message.match(/Option '(-\w)[\s\S]+To specify an option[\s\S]+use '(--[\w]+)/))
            return console.error(`Option '${matches[1]}, ${matches[2]} <value>' argument missing`)
        if (err.message.startsWith('Unknown option'))
            return console.error(err.message.slice(0, err.message.indexOf("'.") + 2))
        return console.error(err.message)
    }
}

export function parseHumanReadableBytes(size_str: string) {
    if (!size_str.length)
        return

    const size_str_upper = size_str.toUpperCase()

    if (size_str_upper.at(-1) === 'B') {
        const unit = size_str_upper.at(-2)

        if (unit === undefined)
            return

        // @ts-ignore
        if (unit < 10) // a digit part of byte value
            return +size_str.slice(0, -1)

        const unit_index = BYTE_UNITS.indexOf(unit)
        return (unit_index > -1) ? parseByUnitIndex(unit_index, size_str.slice(0, -2)) : undefined
    }

    const unit = size_str_upper.at(-1)

    // @ts-ignore
    if (unit < 10) // a digit part of byte value
        return +size_str

    const unit_index = BYTE_UNITS.indexOf(unit!)

    return (unit_index > -1) ? parseByUnitIndex(unit_index, size_str.slice(0, -1)) : undefined

    function parseByUnitIndex(index: number, value: string) {
        return parseFloat(value) * Math.pow(1024, 1 + index)
    }
}

export function getClientMaxBodySize(config: any) {
    if (typeof config.cached.http_client_max_body_size === undefined) {
        const max = config.http.client_max_body_size
        config.cached.http_client_max_body_size = parseHumanReadableBytes(max) || '';
        return max ? config.cached.http_client_max_body_size : undefined
    }
    return config.cached.http_client_max_body_size || undefined
}

export function getMaxWorker(config: any) {
    if (config.worker_processes === 'auto')
        return navigator.hardwareConcurrency
    return parseInt(config.worker_processes) || 1
}

export default { parseCLIArgs }