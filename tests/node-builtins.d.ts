declare module 'node:fs/promises' {
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
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
