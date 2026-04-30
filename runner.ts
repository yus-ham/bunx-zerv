import { watch } from "fs";
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
    if (!isGlob && opts.watch === opts.watchExec && !(await file(opts.watch).exists())) {
        targetFile = basename(opts.watch);
        watchPath = dirname(opts.watch);
        console.warn(`${timestamp()}  ${styleText('yellow', 'Warning:')} Target file ${opts.watch} does not exist. Watching directory ${watchPath} for its creation...`);
    } else if (!isGlob && !(await file(watchPath).exists())) {
        console.warn(`${timestamp()}  ${styleText('yellow', 'Warning:')} Path does not exist: ${watchPath}. Waiting for it to be created...`);
    }

    const isExecWatch = !isGlob && opts.watch === opts.watchExec;
    console.info(styleText('cyan', `    - ${isExecWatch ? 'Watch Exec' : 'Watch' + ' '.repeat(5)}: ${opts.watch}`));
    console.info(styleText('cyan', `    - Exec      : ${opts.watchExec || 'none'}`));

    try {
        watch(watchPath, { recursive: true }).on('change', async (event, filename) => {
            if (!filename) return;
            
            // If we are in "watch parent for missing target" mode
            if (targetFile && basename(filename) !== targetFile) return;

            const fullPath = watchPath === '.' ? filename : join(watchPath, filename).replaceAll('\\', '/');
            
            if (glob && !glob.match(fullPath)) return;

            if (opts.watchExec) {
                console.info(`${timestamp()}  ${styleText('yellow', 'File changed:')} ${filename}. ${styleText('cyan', 'Executing:')} ${opts.watchExec}`);
                try {
                    await $`${{ raw: opts.watchExec }}`;
                } catch (err: any) {
                    console.error(`${timestamp()}  ${styleText('red', 'Execution failed:')} ${err.message}`);
                }
            }

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
