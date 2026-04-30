#!/usr/bin/env bun

import run from "./server.ts"
import { parseCLIArgs, printHelp, gapura } from "./console.ts"
import { startWatcher } from "./runner.ts"

const DEFAULT_CONFIG_FILE = 'config/main/default.conf'

try {
    const opts = await parseCLIArgs(DEFAULT_CONFIG_FILE, process.argv.slice(2))
    
    if (opts.help) {
        printHelp()
    } else {
        console.info(gapura())
        if (opts.isWatcherOnly) {
            await startWatcher(opts)
        } else {
            await run(opts)
        }
    }
} catch (err: any) {
    console.error(err.stack || err.message)
}
