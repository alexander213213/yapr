import fs from "fs"
import path from "path"

const LOG_FILE = path.resolve("messages.log")

const stream = fs.createWriteStream(LOG_FILE, { flags: "a" })

function timestamp(): string {
    return new Date().toISOString()
}

function write(direction: "OUT" | "IN", payload: object): void {
    const line = `[${timestamp()}] [${direction}] ${JSON.stringify(payload)}\n`
    stream.write(line)
}

export const logger = {
    out: (payload: object) => write("OUT", payload),
    in:  (payload: object) => write("IN",  payload),
}