import type ts from 'typescript';

import type { SchemaResolution } from './schema-resolution.interface';

export type ContractKind = 'variable' | 'property' | 'parameter' | 'return' | 'expression';

export interface ContractDescriptor {
  readonly node: ts.Node;
  readonly name: string;
  readonly kind: ContractKind;
  readonly resolution: SchemaResolution;
  readonly sourceFile: ts.SourceFile;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}
