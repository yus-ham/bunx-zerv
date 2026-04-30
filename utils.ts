const BYTE_UNITS = 'KMGTPEZY';

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

export function parseHumanReadableTime(time: string) {
    if (!time) {
        return
    }
    let [, num, unit] = time.trim().match(/^(\d+)(\w*)/)
    num = parseInt(num)
    switch (unit) {
        case 'h': return num * 60 * 60 * 1000
        case 'm': return num * 60 * 1000
        case 's': return  num * 1000
        default: return num
    }
}

export function getKeepAliveTimeout(config: any) {
    if (typeof config.cached.keepalive_timeout === undefined) {
        const timeout = parseHumanReadableTime(config.http.keepalive_timeout)
        config.cached.keepalive_timeout = timeout ? timeout / 1000 : 60
    }
    return config.cached.keepalive_timeout
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