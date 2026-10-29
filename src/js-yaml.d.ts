/** Narrow declarations for the pinned, bundled non-executing YAML reader. */
declare module 'js-yaml' {
  export interface Schema { extend(type: Type): Schema }
  export class Type {
    constructor(tag: string, options: { kind: 'scalar'; resolve(data: unknown): boolean; construct(data: string): unknown })
  }
  export const JSON_SCHEMA: Schema
  export function load(text: string, options: { schema: Schema }): unknown
}
