declare module "opentype.js" {
  interface NameBag {
    en?: string;
  }
  interface Font {
    getAdvanceWidth(text: string, fontSize: number): number;
    names: {
      windows?: { fontFamily?: NameBag };
      fontFamily?: NameBag;
    };
  }
  function parse(buffer: ArrayBuffer): Font;
  const opentype: { parse: typeof parse };
  export default opentype;
  export { parse, Font };
}

declare module "*.ttf" {
  const content: ArrayBuffer;
  export default content;
}

declare module "*.png" {
  const content: ArrayBuffer;
  export default content;
}

declare module "*.wasm" {
  const content: WebAssembly.Module;
  export default content;
}

declare module "@resvg/resvg-wasm/index_bg.wasm" {
  const content: WebAssembly.Module;
  export default content;
}

declare module "node:fs/promises" {
  export function readFile(path: string): Promise<Uint8Array>;
}

declare module "node:path" {
  export function resolve(...parts: string[]): string;
}

declare module "node:module" {
  export function createRequire(filename: string): { resolve(id: string): string };
}

declare const process: { cwd(): string };
