# Changelog

All notable changes to `@ts-typed/compiler` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-17

A pass over real NestJS + TypeORM + SQLite usage found that the single highest-impact gap was coverage, not any individual bug: class methods, constructors and decorated fields were never instrumented at all, and several common type shapes (`Date`, callback-typed properties) made their whole containing contract silently `unsupported`. This release closes those gaps and fixes twelve runtime-breaking or silently-incorrect bugs found along the way.

### Added

- Class methods, getters, setters and constructors are now instrumented (parameters and return values), closing the largest coverage gap: a NestJS controller/service/repository method is now protected the same way a free function always was.
- Decorated class fields and parameters (`class-validator`, `@nestjs/swagger`, TypeORM `@Column`/`@OneToMany`, etc.) are resolved by their own type instead of being unconditionally marked `unsupported`.
- `Date` is supported as a first-class runtime contract, including explicitly rejecting `Invalid Date` with a `StrictTypeError` instead of letting it surface later as an unrelated `RangeError`.
- A property or parameter typed as a plain function (a callback field, an interface method signature) is validated as `typeof value === 'function'` instead of making its whole containing object type `unsupported`.
- Template literal types (`` `${number}px` ``, `` `user_${string}` ``, `` `${boolean}-flag` ``, etc.) are converted to an anchored regular expression at compile time and validated against it.
- `yield` inside a generator function is validated against its declared/inferred yielded type; `AsyncGenerator`/`Iterable`/`IterableIterator` are supported the same way. (`yield*` delegation is left unprotected — validating a whole delegated iterable up front is a different, larger problem.)
- A required class field (no `?`) can no longer be removed with `delete` or have its guard replaced via `Object.defineProperty`, bypassing validation entirely. The lock is deferred to the most-derived class's own constructor (checked via `new.target`), so a subclass that legitimately redeclares the same field is unaffected.
- Compound assignment on a guarded variable (`+=`, `-=`, `*=`, `/=`, `%=`, `**=`, shifts, bitwise) is now rewritten into a validated assignment instead of running unguarded. `&&=`, `||=` and `??=` are left exactly as before — rewriting them would change short-circuit evaluation — and keep warning as unsupported.
- Every coverage-affecting diagnostic computed during analysis (not just the ones a transform happens to touch) now reaches the build's coverage report and `compiler.onUnsupported: "error"`'s failure message, which now names the offending contract and reason instead of only a count.
- `diagnostics.reportFile` actually writes the coverage report to disk, as JSON, creating parent directories as needed; a write failure fails the build instead of being silently swallowed.
- `strictNullChecks` (directly, or via `strict: true`) is now a hard requirement, checked before any analysis runs, per the original spec — a project without it now fails fast with a clear diagnostic instead of building successfully on a checker view that is already too lossy to protect against.
- A project configuring `paths` aliases in `tsconfig.json` now fails the build with a clear diagnostic, in both the bundled and the unbundled output: TypeScript never rewrites aliases in its own emitted JavaScript, and `@vercel/ncc` does not read tsconfig `paths` either, so either path previously reported success while producing a "Cannot find module" failure at runtime.
- The package's `exports` map now exposes `./package.json`, so `require.resolve('@ts-typed/compiler/package.json')` and similar version-probing patterns work.

### Fixed

- A type assertion or cast used directly as an assignment target (`(x as T) = v`, `(x as T) += 1`, `(x as any)++`/`--`) produced invalid JavaScript (`Invalid left-hand side in assignment`) instead of being erased the way `tsc` itself erases a cast. Casting the *object* of a member assignment (`(a as T).b = v`) is unaffected and continues to validate `a` as a read.
- `compiler.enforcePrivate` (the default) broke construction of any class with a plain `private` field: the structural schema still required the field under its pre-`#private` name after the transformer had already converted it to a real `#private` accessor. The field is now correctly excluded from the structural schema instead of marking the whole class `unsupported`.
- A branded/tagged primitive type (`string & { readonly __brand: 'Id' }`, the standard TypeScript nominal-typing idiom) rejected every value, because the phantom `object` member of the intersection was validated against primitive values that can never carry it. It is now ignored when the value being checked is a primitive; an intersection applied to a real object value is unaffected and still enforces every member.
- A project compiling to native ESM (`module` resolving to an ES module kind) got a `require(...)` call injected into the generated ES module, crashing immediately with `ReferenceError: require is not defined`. The injected runtime reference is now an `import` declaration when the target module format is ESM, and unchanged (`require`) for CommonJS.
- A comparison against a guarded variable (`port >= MIN`, `x === y`, …) emitted a false "compound assignment" coverage warning, because every non-`=` binary operator was treated as an assignment attempt regardless of whether it actually was one.
- `compiler.onUnsupported: "error"` could fail a build without ever saying which contract caused it.

### Fixed (`@ts-typed/nestjs`-relevant, surfaced through NestJS testing)

- See `@ts-typed/nestjs`'s own changelog for the HTTP exception filter fix (`StrictTypeError` from a return-value violation now maps to 500, not 400).

### Known limits (new, in addition to the ones already listed below)

- Generic type parameters still have no concrete runtime contract inside a generic function's own body (`identity<User>(x)` validates nothing extra inside `identity`): the type is erased before any single call site's concrete argument is known to the instrumented body.
- `Map`/`Set` contents, `static` class fields, and reflective mutation of a validated array (`push`/`splice`/index assignment/`length`) are still unprotected.
- A destructuring binding (`const { age }: T = value`) still does not validate `value` against `T` before destructuring.
- A user-authored type predicate (`x is T`) or assertion function (`asserts x is T`) is trusted as-is; a predicate that lies is not caught.
- `readonly` on an interface or type-alias member (as opposed to a class field) is not enforced — the value is still writable through that property.
- Extra properties or `symbol`-keyed properties added directly to a class instance after construction are not rejected (property-level extras on a *nested* plain object already were, and remain, rejected by default).

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
