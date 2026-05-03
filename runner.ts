import { watch, existsSync } from "fs";
import { styleText } from "util";
import { $, Glob, file } from "bun";
import { join, dirname, basename } from "path";
import { timestamp } from "./console";
import { CLIOptions } from "./console";

export async function startWatcher(opts: CLIOptions) {
    if (!opts.watch) return;

    const isGlob = /[*?\[{}]/.test(opts.watch);
    let watchPath = isGlob ? getBaseDir(opts.watch) : opts.watch;
    const glob = isGlob ? new Glob(opts.watch) : null;
    let targetFile = "";

    // If watching a non-existent file that is also the exec target, watch its parent dir
    if (!isGlob && opts.watch === opts.watchExec && !existsSync(opts.watch)) {
        targetFile = basename(opts.watch);
        watchPath = dirname(opts.watch);
        console.warn(`${timestamp()}  ${styleText('yellow', 'Warning:')} Target file ${opts.watch} does not exist. Watching directory ${watchPath} for its creation...`);
    } else if (!isGlob && !existsSync(watchPath)) {
        console.warn(`${timestamp()}  ${styleText('yellow', 'Warning:')} Path does not exist: ${watchPath}. Waiting for it to be created...`);
    }

    // ... existing setup logic ...
    console.info(styleText('cyan', `    - Watch      : ${opts.watch}`));
    console.info(styleText('cyan', `    - Exec       : ${opts.watchExec || 'none'}`));
    console.info(styleText('magenta', `    - Hint       : Press 'r' + Enter to restart execution`));

    const execute = async () => {
        if (!opts.watchExec) return;
        console.info(`${timestamp()}  ${styleText('cyan', 'Executing:')} ${opts.watchExec}`);
        try {
            await $`${{ raw: opts.watchExec }}`;
        } catch (err: any) {
            console.error(`${timestamp()}  ${styleText('red', 'Execution failed:')} ${err.message}`);
        }
    };

    // Listen for 'r' key in stdin
    process.stdin.setRawMode(false); // keep it simple with line buffered
    process.stdin.on('data', (data) => {
        if (data.toString().trim() === 'r') {
            console.info(`${timestamp()}  ${styleText('yellow', 'Manual restart triggered.')}`);
            execute();
        }
    });

    try {
        watch(watchPath, { recursive: true }).on('change', async (event, filename) => {
            if (!filename) return;
            
            // ... (existing watch logic)
            if (glob && !glob.match(fullPath)) return;

            execute();
        });
    } catch (err: any) {

        if (err.code === 'ENOENT') {
            console.error(`${timestamp()}  ${styleText('red', 'Error:')} Cannot watch non-existent path: ${watchPath}`);
        } else {
            console.error(`${timestamp()}  ${styleText('red', 'Error:')} ${err.message}`);
        }
    }
}

function getBaseDir(pattern: string) {
    const globIndex = pattern.search(/[*?\[{}]/);
    if (globIndex === -1) return pattern;
    const base = pattern.slice(0, globIndex);
    const lastSlash = base.lastIndexOf('/');
    if (lastSlash === -1) return '.';
    return base.slice(0, lastSlash) || '/';
}
