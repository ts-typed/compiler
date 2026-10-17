# Changelog

All notable changes to `@ts-typed/compiler` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.1] - 2026-10-16

Initial release.

### Added

- Runtime protection layer: `StrictTypeError`, `assertValue`, `protectValue`, `SchemaRegistry`, and the `Schema` model covering primitives, literals, unions, intersections, arrays, tuples, objects (including index signatures and deferred-assignment fields), and references.
- `AllowExtraProperties()` decorator (class- and property-level) for explicit, auditable exceptions to the closed-object default.
- `StrictClass()` / `StructuralClass()` decorators and `compiler.strictClass` to choose between structural (default) and nominal (`instanceof`) validation for class-typed contracts.
- Compiler analysis (`analyzeProject`) that resolves materializable TypeScript types into runtime schemas via the TypeChecker, including generics, mapped types, conditional types, discriminated unions, recursive types, and `Pick`/`Omit`/`Partial`/`Required`/`Record`/`Readonly` utility types.
- Contract transformer (`createContractTransformer`) that instruments variables, parameters, returns, class fields, and type assertions with runtime guards, preserving evaluation order and identity.
- `compiler.enforcePrivate`: rewrites TypeScript `private` class fields into real ECMAScript `#private` fields with a validating accessor pair, since TypeScript's own `private` has no runtime effect. Fails the build if a field being converted is accessed through bracket notation anywhere in the program (no `#private` equivalent exists for that pattern).
- `compiler.enforceReadonly`: locks `readonly` class fields against further writes once their declaring constructor finishes, instead of leaving them silently writable.
- Project configuration (`typets.config.json`): `loadConfig`, `initializeProject`, published JSON Schema with editor autocomplete, `extends` inheritance with cycle detection, and full precedence (defaults < inherited < project file < explicit overrides).
- Build pipeline (`buildProject`): atomic output (rename-based swap, never erases a previously valid `outDir` before a new build succeeds), per-file emit, asset copying, and optional `@vercel/ncc` bundling over already-instrumented JavaScript (never over TypeScript sources directly).
- CLI (`ts-typed init|build|help`) with `--root`, `--config`, `--no-bundle`, `--minify`, `--sourcemap` flags, each mapping to an existing configuration option.
- Coverage reporting (`createCoverageReport`, `formatCoverageReport`): every typed point is classified as protected, partial, unsupported, or open, with file/line/column and a human-readable reason — never silently reported as fully protected when it is not.
- Versioned integration adapter contract (`IntegrationAdapterV1`) so framework-specific packages (starting with `@ts-typed/nestjs`) can resolve project configuration without the core depending on any framework.
- Internal, undocumented per-stage build timing (`TS_TYPED_BUILD_METRICS=1`), inert by default and not part of the public configuration surface — used only for this project's own development to spot bottlenecks.

### Known limits (by design, reported honestly rather than hidden)

- External aliases of a protected value and some reflective operations can escape local guards; this is accepted under the project's compatibility policy and surfaced as partial-protection warnings, never silently promoted to full protection.
- `compiler.strictClass`'s `instanceof` check can only be attached when the compiler can embed a live reference to the class — i.e., when it is declared in the same file as the validation point. Cross-file classes fall back to structural validation with a coverage warning when `compiler.strictClass` is enabled.
- `compiler.enforcePrivate` is scoped to plain property declarations; parameter properties (`constructor(private foo: string)`) remain unconditionally unsupported, since there is no conversion path for that shorthand yet.
- A class with a true `#private` field, or any method (callable member), cannot be represented as a structural object schema and is reported `unsupported` rather than silently treated as open.
