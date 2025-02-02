#!/bin/env bun

import run from "./server.ts"

try {
    await run()
} catch(err) {
    console.error(err.stack)
}
