import type { AnalysisResult, CoverageDiagnostic } from '../analysis';

export interface ContractTransformerOptions {
  readonly analysis: AnalysisResult;
  readonly runtimeModule?: string | ((sourceFile: import('typescript').SourceFile) => string);
  readonly allowExtraPropertiesAll?: boolean;
  /**
   * Compiled-in default for class-typed contracts: `false` (default)
   * validates structurally; `true` requires `instanceof` wherever a live
   * class reference can be embedded (same file as the validation point).
   * A per-class `@StrictClass()`/`@StructuralClass()` decorator overrides
   * this at validation time regardless of what is compiled in here.
   */
  readonly strictClass?: boolean;
  /**
   * When true, `readonly` class fields are validated like any other field
   * and then locked against further writes once their declaring
   * constructor finishes, instead of being left entirely unprotected.
   */
  readonly enforceReadonly?: boolean;
  /**
   * When true, `private` class fields are rewritten into real ECMAScript
   * `#private` fields with an inlined validating accessor pair, instead of
   * staying reflectively public and entirely unprotected. Requires
   * {@link AnalyzeProjectContext.enforcePrivate} to have been set to true
   * on the same `analysis` so `privateBracketAccessConflicts` is populated;
   * converting a field accessed through bracket notation anywhere in the
   * program throws synchronously, failing the build, since that access
   * pattern has no `#private` equivalent.
   */
  readonly enforcePrivate?: boolean;
  readonly onDiagnostic?: (diagnostic: CoverageDiagnostic) => void;
}
