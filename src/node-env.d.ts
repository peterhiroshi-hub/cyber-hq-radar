declare module 'node:child_process' {
  export interface ExecFileOptions {
    timeout?: number
    maxBuffer?: number
    env?: Record<string, string | undefined>
  }
  export function execFile(
    file: string,
    args?: readonly string[] | null,
    options?: ExecFileOptions | null,
    callback?: (error: Error | null, stdout: string, stderr: string) => void
  ): unknown
}

declare module 'node:util' {
  export function promisify<TArgs extends unknown[], TResult>(
    fn: (...args: [...TArgs, (err: Error | null, result: TResult) => void]) => unknown
  ): (...args: TArgs) => Promise<TResult>
}

declare const process: {
  env: Record<string, string | undefined>
}

declare module 'node:os' {
  export function totalmem(): number
  export function freemem(): number
  export function loadavg(): number[]
  export function cpus(): { model: string }[]
  export function homedir(): string
  export function hostname(): string
  export function platform(): string
}

declare module 'node:path' {
  export function join(...paths: string[]): string
  export function basename(p: string): string
  export function dirname(p: string): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string
}

declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  export function writeFile(path: string, data: Uint8Array | string): Promise<void>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function access(path: string): Promise<void>
}

declare module 'node:crypto' {
  export function randomBytes(size: number): { toString(enc: 'hex'): string }
}

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string
    url?: string
    headers: Record<string, string | string[] | undefined>
    on(event: 'data', listener: (chunk: Uint8Array | string) => void): void
    on(event: 'end', listener: () => void): void
    on(event: 'close', listener: () => void): void
  }
  export interface ServerResponse {
    writeHead(statusCode: number, headers?: Record<string, string>): void
    write(chunk: string | Uint8Array): boolean
    end(chunk?: string | Uint8Array): void
  }
  export interface Server {
    listen(port: number, host: string, cb?: () => void): void
    address(): { port: number; address: string } | string | null
    close(cb?: () => void): void
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server
}

declare const __dirname: string | undefined

declare const Buffer: {
  from(input: string, encoding: 'base64' | 'utf8'): Uint8Array & { length: number; toString(encoding?: string): string }
}
