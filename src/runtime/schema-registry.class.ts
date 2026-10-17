import type { Schema } from './schema.type';

export class SchemaRegistry {
  private readonly _schemas = new Map<string, Schema>();

  public define(name: string, schema: Schema): void {
    this._schemas.set(name, schema);
  }

  public get(name: string): Schema | undefined {
    return this._schemas.get(name);
  }
}
