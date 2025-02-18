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
  -c, --config <file>    Use config file
  -s, --save             Clone default config and save into config file if does not exist
```
All arguments are optional but for complex configuration, you can use custom config file instead.
