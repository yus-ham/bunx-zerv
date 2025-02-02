# Zerv
Bun HTTP server with Nginx style configurations

## Installation
`bun add -g bunx-zerv`

## Usage
Simply run `zerv` or `bunx zerv` if you want to skip installation process, this will start serving current directory to port 3000 of all available network interfaces (`0.0.0.0`).

Try opening http://localhost:3000 in your browser.

`zerv [[<hostname>:]<port>] [<directory>] [--spa] [-c, --config <file>]`
```
hostname        defaults to '0.0.0.0'
port            defaults to '3000'
directory       defaults to current working directory
--spa           enable SPA mode
-c, --config    defaults to 'config/main/default.conf' or can be found exactly at `$HOME/.bun/install/cache/bunx-zerv/config/main/default`
```
All arguments are optional but for complex configuration, you can use custom config file instead.
