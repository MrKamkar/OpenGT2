declare module 'node:fs/promises' {
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export interface FileHandleReadResult {
    readonly bytesRead: number;
    readonly buffer: Uint8Array;
  }

  export interface FileStats {
    readonly size: number;
    readonly mtimeMs: number;
  }

  export interface FileHandle {
    read(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): Promise<FileHandleReadResult>;
    stat(): Promise<FileStats>;
    close(): Promise<void>;
  }

  export function open(path: string, flags: 'r'): Promise<FileHandle>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
}

declare module 'node:zlib' {
  export interface ZlibGunzipInfoResult {
    readonly buffer: Uint8Array;
    readonly engine: { readonly bytesWritten: number };
  }

  export function gunzipSync(
    buffer: Uint8Array,
    options: { readonly info: true },
  ): ZlibGunzipInfoResult;
}

declare module 'node:path' {
  const path: {
    dirname(p: string): string;
    extname(p: string): string;
    join(...paths: string[]): string;
    relative(from: string, to: string): string;
    resolve(...paths: string[]): string;
  };
  export default path;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:process' {
  export const env: Record<string, string | undefined>;
}

declare module 'node:buffer' {
  export const Buffer: {
    alloc(size: number, fill?: number): Uint8Array;
    from(data: ArrayLike<number>): Uint8Array;
  };
}
