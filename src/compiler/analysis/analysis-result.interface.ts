import type ts from 'typescript';

import type { ContractDescriptor } from './contract-descriptor.interface';
import type { CoverageDiagnostic, CoverageItem } from './coverage.interface';
import type { TypeSchemaResolver } from './type-schema-resolver';

export interface AnalyzeProjectContext {
  readonly tsconfigPath: string;
  readonly compilerOptions?: ts.CompilerOptions;
  /**
   * When true, `private` class fields are resolved like any other field
   * (instead of being unconditionally unsupported) so they can be rewritten
   * into real `#private` fields downstream. Also triggers a whole-program
   * scan for bracket-notation access to such fields, exposed through
   * {@link AnalysisResult.privateBracketAccessConflicts}, since that access
   * pattern has no `#private` equivalent.
   */
  readonly enforcePrivate?: boolean;
}

export interface PrivateBracketAccessConflict {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface AnalysisResult {
  readonly typescript: typeof import('typescript');
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly resolver: TypeSchemaResolver;
  readonly contracts: ReadonlyMap<ts.Node, ContractDescriptor>;
  readonly coverage: readonly CoverageItem[];
  readonly diagnostics: readonly CoverageDiagnostic[];
  readonly tsDiagnostics: readonly ts.Diagnostic[];
  /**
   * Bracket-notation accesses (`obj['fieldName']`) found anywhere in the
   * program that target a `private` field symbol, keyed by that symbol.
   * Populated only when {@link AnalyzeProjectContext.enforcePrivate} is
   * true. A `#private` field has no bracket-notation equivalent, so the
   * transformer treats any entry here as a fatal build error for that
   * field rather than silently dropping the access pattern it relies on.
   */
  readonly privateBracketAccessConflicts: ReadonlyMap<ts.Symbol, readonly PrivateBracketAccessConflict[]>;
  /**
   * Internal, undocumented timing for the two phases this function runs
   * through (creating/binding the `ts.Program` vs. walking it to resolve
   * contracts). Not part of the supported public API; existence purely to
   * help `buildProject` surface `TS_TYPED_BUILD_METRICS=1` diagnostics.
   */
  readonly internalTimingMs: { readonly projectLoad: number; readonly typeAnalysis: number };
}
