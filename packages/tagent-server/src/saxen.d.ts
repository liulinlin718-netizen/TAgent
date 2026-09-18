// saxen 11 has no bundled declarations; keep the surface used by import validation explicit.
declare module 'saxen' {
  export class Parser {
    on(event: 'error' | 'warn', callback: (error: Error) => void): this;
    on(event: 'openTag', callback: (name: string, attributes: () => Record<string, string>) => void): this;
    parse(xml: string): void;
  }
}
