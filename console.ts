import { parseArgs, styleText } from "util";
import { file } from "bun";
import { join, resolve } from "path";
import { version } from "./package.json";

export type CLIOptions = {
    help: boolean;
    config: string;
    save: boolean;
    spa: boolean;
    cors: boolean;
    root: string;
    port?: string | number;
    hostname: string;
    watch?: string;
    watchExec?: string;
    isWatcherOnly?: boolean;
}

const LISTEN_ADDR_RE = /^((.+):)?(\d+)$/

export const gapura = () => styleText(['bold', 'cyan'], 'Welcome to Zerv ') + `(${version})\n`
export const timestamp = (d = '') => styleText('blueBright', `[${(d = new Date().toISOString()), d.slice(0, 10)} ${d.slice(11, 23)}]`)

export async function parseCLIArgs(config_file: string, args?: string[]) {
    try {
        const { values, positionals } = parseArgs({
            allowPositionals: true,
            options: {
                help: { type: 'boolean', short: 'h' },
                config: { type: 'string', short: 'c', default: config_file },
                save: { type: 'boolean', short: 's' },
                cors: { type: 'boolean' },
                spa: { type: 'boolean' },
                watch: { type: 'string' },
                'watch-exec': { type: 'string' },
                'watch-exe': { type: 'string' },
            },
            ...(args ? { args } : {}),
        }) as never as { values: CLIOptions & { 'watch-exec'?: string, 'watch-exe'?: string }; positionals: string[] }

        const [listen, root] = positionals

        if (values['watch-exec']) {
            values.watchExec = values['watch-exec']
            delete values['watch-exec']
        }

        if (values['watch-exe']) {
            values.watchExec = values['watch-exe']
            delete values['watch-exe']
        }

        const matches = listen?.match(LISTEN_ADDR_RE) || []
        values.hostname = matches[2]

        let hasPositional = false;

        if (root) {
            values.root = normalizeDirectory(root)
            values.port = parseInt(matches[3])
            hasPositional = true;
        } else {
            if (listen && !matches[3]) {
                values.root = normalizeDirectory(listen)
                hasPositional = true;
            } else {
                values.root = process.cwd().replaceAll('\\', '/')
                if (matches[3]) {
                    values.port = parseInt(matches[3])
                    hasPositional = true;
                }
            }
        }

        if (!hasPositional && (values.watch || values.watchExec)) {
            values.isWatcherOnly = true;
        }

        const root_stat = await file(values.root).stat()

        if (!root_stat.isDirectory())
            exit('Invalid directory to serve: ' + values.root)

        return values
    } catch (err: any) {
        if (err.message.startsWith('Unexpected argument'))
            exit(err.message.slice(0, err.message.indexOf("'. ") + 1))

        let matches
        if (matches = err.message.match(/Option '(-\w)[\s\S]+To specify an option[\s\S]+use '(--[\w]+)/))
            exit(`Option '${matches[1]}, ${matches[2]} <value>' argument missing`)

        if (err.message.startsWith('Unknown option'))
            exit(err.message.slice(0, err.message.indexOf("'.") + 2))

        exit(err.message)
    }
}

function normalizeDirectory(directory: string) {
    if (directory.startsWith('/') || directory.includes(':'))
        return directory.replaceAll('\\', '/')

    return join(process.cwd(), directory).replaceAll('\\', '/')
}

function exit(message: string) {
    if (process.env.NODE_ENV !== 'test') {
        console.error(message)
        process.exit(1)
    }
}

export function printHelp() {
    console.info(gapura())
    console.info(`${styleText('yellow', 'Usage:')}\n  zerv [[<hostname>:]<port>] [<directory>] [...options]\n`)
    console.info(styleText('yellow', 'Arguments:'))
    console.info(`  ${styleText('green', 'hostname')}       Host name to be listen on, defaults to ${styleText('green', '0.0.0.0')}`)
    console.info(`  ${styleText('green', 'port')}           Port to be listen on, defaults to ${styleText('green', '3000')}`)
    console.info(`  ${styleText('green', 'directory')}      Root directory to be served at, defaults to current working directory`)
    console.info(styleText('yellow', '\nOptions:'))
    console.info(`  ${styleText('green', '--spa')}                  Enable SPA mode`)
    console.info(`  ${styleText('green', '--cors')}                 Enable CORS mode`)
    console.info(`  ${styleText('green', '--watch <pattern>')}      Watch directory or glob pattern for changes`)
    console.info(`  ${styleText('green', '--watch-exe <script>')}   Script to execute on change`)
    console.info(`  ${styleText('green', '-c, --config [<file>]')}  Use config file, defaults to 'config/main/default.conf'`)
    console.info(`  ${styleText('green', '-s, --save')}             Clone default config and save into config file if does not exist`)
    console.info('')
}
