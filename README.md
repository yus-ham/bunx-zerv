# Zerv
Bun HTTP server with Nginx style configurations

## Installation
`bun add -g zerv`

## Usage
Simply run `zerv` or `bunx zerv` if you want to skip installation process, this will start serving current directory to port 3000 of all available network interfaces (`0.0.0.0`).

Try opening http://localhost:3000 in your browser.

`zerv [[<hostname>:]<port>] [<directory>] [...options]`
```
Arguments:
  hostname       Host name to be listen on, defaults to 0.0.0.0
  port           Port to be listen on, defaults to 3000
  directory      Root directory to be served, defaults to current working directory

Options:
  --spa                  Enable SPA mode
  --cors                 Enable CORS mode
  --watch <pattern>      Watch directory or glob pattern for changes
  --watch-exe <script>   Script to execute on change
  -c, --config <file>    Use config file
  -s, --save             Clone default config and save into config file if does not exist
```

### Watcher Mode
Zerv includes a powerful file watcher that can trigger commands on changes.

**Watch files and run a command:**
`zerv --watch "src/*.ts" --watch-exe "bun run build"`

**Watcher-only mode:**
If you provide watch flags without a port or directory, Zerv will run in watcher-only mode (no HTTP server started).
`zerv --watch . --watch-exe "echo File changed!"`

**Watching non-existent execution targets:**
If the file you are watching is also the execution target (e.g., watching a binary you are compiling), Zerv will gracefully watch the parent directory until the target is created.
`zerv --watch ./bin/app.exe --watch-exe ./bin/app.exe`

All arguments are optional but for complex configuration, you can use custom config file instead.
