# Changelog

All notable changes to `@ts-typed/compiler` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.8] - 2026-10-18

### Added

- A new opt-in `compiler.enforceMutationGuards` config flag (default `false`) closes the `ARRAY_MUTATION` gap for the common case: when set to `true`, an array crossing a typed boundary (e.g. `const scores: number[] = value;`) is wrapped in a `Proxy` whose `set` trap validates any new element written to a numeric index — directly (`scores[3] = 'x'`), or indirectly through a mutating method that writes indices under the hood (`.push()`, `.splice()`, `.unshift()`, …) — against the array's item schema before the write is allowed to go through, throwing `StrictTypeError` (`operation: 'mutate'`, same `TYPE_MISMATCH` shape as any other boundary violation) on a mismatch. `length` reads/writes are left alone (truncating or growing an array is not itself a type violation). This is opt-in because validating every element write has a real per-write cost, and because the wrapped proxy is a different object reference from the original array — any code comparing the two by identity after assignment would need to be aware of it.

  **Known limitations, not covered by this release:** only the direct result of a boundary crossing is wrapped — an array stored in a typed class field (assigned through `installFieldGuard`'s own setter path) is not wrapped, nor is an array nested inside a plain object/another array. A value typed as `T[] | undefined` (or any other union containing an array) is not wrapped, since the schema resolves to `kind: 'union'`, not `kind: 'array'`, at the point `protectValue` runs — a real gap for the common optional-array case, left for a follow-up. A reference to the same array taken BEFORE it crosses the boundary (`const raw = []; const typed: number[] = raw; raw.push('x')`) bypasses the proxy entirely, since `raw` was never replaced by the wrapped value. `Map`/`Set` mutation (`.set()`/`.add()` after the boundary) remains open as the separate `MAP_SET_MUTATION` gap.

## [0.1.7] - 2026-10-18

### Added

- A new opt-in `compiler.enforceClosedInstances` config flag (default `false`) closes the `CLOSED_INSTANCES`/`SYMBOL_KEYS` gap: when set to `true`, a class instance becomes non-extensible (`Object.preventExtensions(this)`) once construction of its most-derived class fully completes, reusing the same `new.target` guard already used for readonly/required field locking so a subclass's own fields are still installed before the seal. Once sealed, no new property — string- or symbol-keyed — can be added to the instance; declared fields can still be reassigned normally. Rejection uses native `Object.preventExtensions` semantics (a `Reflect.set` of a new property returns `false`; a direct strict-mode assignment throws a native `TypeError`), not `StrictTypeError` — turning that into a catchable `StrictTypeError` would need a `Proxy` wrapper around every instance, which is more overhead than this opt-in trade-off calls for.

  **This is deliberately opt-in, and enabling it is a cross-cutting decision, not a free correctness upgrade.** The previous attempt at this (see 0.1.3's "deliberately NOT shipped" note) broke NestJS's `class-transformer` + `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` pattern, which copies every request-body key onto a `new Dto()` instance first and only strips non-whitelisted keys afterward — sealing the instance makes that first copy throw before the whitelist step ever runs. If you turn `enforceClosedInstances` on, you must configure the rest of your stack to never write an undeclared key to that class in the first place (e.g. `class-transformer`'s `excludeExtraneousValues: true` with `@Expose()` decorators, which only ever writes known keys, instead of copy-then-strip). **A mismatch between this flag and another library's config is an application configuration bug, not a ts-typed bug**: the same rule applies to any other ts-typed/third-party option pair (e.g. `allowExtraPropertiesAll` vs. a validator's own whitelist setting) — pick one behavior and configure every layer to agree with it.

  Anonymous class expressions are not sealed (there is no name for `new.target` to compare against, the same limitation `lockReadonlyField`/`lockRequiredField` already have).

## [0.1.6] - 2026-10-18

### Added

- An exported `let`/`var` module-level binding (`export let exportedCounter: number = 0;`), when compiled to CommonJS, now has a guard installed directly on the `exports` object for that property, reusing `installFieldGuard`. Internal reads/writes within the module keep working exactly as before. An external write through the same `exports` object — e.g. `Reflect.set(importedNamespace, 'exportedCounter', 'wrong')`, or a direct property assignment on an `import * as ns` namespace object, or on the object returned by a separate file's own `require(...)` call (CommonJS gives both the same object) — now throws a `StrictTypeError` (`contractKind: 'variable'`, `operation: 'set'`) when the value doesn't match the declared type, instead of silently corrupting the binding. `export const` is unaffected (TypeScript already rejects reassignment at compile time). Native ESM output is unaffected for a different reason: ES module namespace objects are non-writable by spec, so an external write already throws a plain `TypeError` with no help needed from ts-typed; internal writes there remain covered by the existing per-assignment check. AMD/UMD/System module output and the `let x; export { x };` export-list form are not covered (documented limitation — neither shape exposes the binding as a plain, guardable `exports.x` property in the emitted code).

## [0.1.5] - 2026-10-17

### Added

- A user-defined type guard (`function isProfile(x: unknown): x is Profile`) now validates its target parameter against the asserted type whenever it returns `true` — returning `true` is the claim being made, so it is checked then; returning `false` makes no claim, so nothing is checked in that path. An assertion function (`asserts x is T` / `asserts x`) validates its target at every normal return path (an explicit `return` and falling off the end of the function), since returning normally at all is exactly the claim an assertion function makes; throwing is unaffected. Both are resolved directly by the type resolver at transform time, the same pattern already used for destructuring (0.1.4), async returns and generator yields. A predicate/assertion on `this` (`this is T`, `asserts this`) is not checked (documented limitation, consistent with class instances being excluded from the readonly-structural lock added in 0.1.3).

## [0.1.4] - 2026-10-17

### Added

- A destructured variable declaration (`const { age }: Profile = value;`, `const [first]: number[] = value;`) now validates the WHOLE source value against its declared (or, absent an annotation, inferred) type before destructuring extracts individual bindings — resolved directly by the type resolver at transform time. Individual bindings are not validated separately; validating the source as a whole already covers the real case of a malformed value escaping validation through destructuring. Destructured function parameters remain unsupported (a harder, separate problem: it would require rewriting the function's own signature).

## [0.1.3] - 2026-10-17

Continues the same fix/test/document loop against the real teste-ts-typed app.

### Added

- A `readonly` member of a plain object's interface or type-alias shape (as opposed to a class field, already covered by `compiler.enforceReadonly`) is now locked immediately when the value crosses a typed boundary: `interface Config { readonly version: string }` rejects a later `config.version = 'x'` with `READONLY_PROPERTY`. Unlike a class, a plain object/literal value has no "still under construction" phase, so there is no deferred-lock timing concern here — it is safe to enforce immediately. A `Readonly<T>` mapped type and `readonly` members of index signatures are not detected (documented limitation); class instances are deliberately left out of this specific lock (a `readonly` view of an instance must not freeze that instance's own mutable state).

### Investigated and deliberately NOT shipped this release

- Sealing a class instance with `Object.preventExtensions` right after construction (to reject undeclared/extra properties, `CLOSED_INSTANCES`/`SYMBOL_KEYS`) was implemented and tested in isolation, then reverted before publishing once it broke a real, common pattern found by re-running teste-ts-typed's full suite: NestJS's own `class-transformer` + `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` combination copies every key from the request body onto the DTO instance first, and only strips the non-whitelisted ones afterward as a second step — sealing the instance makes that first copy throw a native, unguarded `TypeError` instead of ever reaching the whitelist step. A general fix would need a way to tell "this class is meant to be populated after construction, by design" apart from a genuinely closed instance, which is not something `contractKind`/`operation` alone can express.

## [0.1.2] - 2026-10-17

A continuation of the same real-app fix/test/document loop that produced 0.1.1: closes three more coverage gaps (`static` fields, `Map`/`Set` adapters), and fixes a severe regression that 0.1.1 itself introduced.

### Fixed

- **Regression in 0.1.1, now fixed**: fixing `installFieldGuard`'s silent give-up (0.1.1) exposed a pre-existing bug in how `compiler.enforceReadonly` decides whether to lock a field. A class with no user constructor installs and locks a readonly field in the SAME synthesized constructor, which completes immediately on `new X()` — correct for a bare field (TypeScript's own `strictPropertyInitialization` guarantees it already has a real value by then), but wrong for a field declared with `?` or `!`: both mean the field may legitimately still be unset, or is only "promised" to be set later, when construction completes. The single most common real-world shape hit by this was NestJS's own `ValidationPipe`: `new Dto()` then `instance.field = value` for every field, assigned by `class-transformer` entirely outside any constructor. 0.1.1 as published locked every such field immediately, making every DTO shaped this way (`readonly name!: string` or `readonly role?: UserRole`) reject the framework's own deserialization step with `READONLY_PROPERTY`, regardless of whether the value being assigned was valid. A readonly field is now only locked when it has neither `?` nor `!`.

### Added

- `static` class fields (public, not combined with `private`/`protected`) are now instrumented: a static field's guard is installed in a `static { ... }` initializer block, where `this` is the class itself, reusing the exact same install/lock machinery already used for instance fields. `delete`/`Object.defineProperty` bypass and `compiler.enforceReadonly` locking both work the same way they do for instance fields.
- `Map<K, V>`, `ReadonlyMap<K, V>`, `Set<T>` and `ReadonlySet<T>` are now first-class schema kinds: their entries/items are validated against the declared key/value/item types when the collection crosses a typed boundary. `WeakMap`/`WeakSet` remain out of scope, and mutating an already-validated collection afterward via `.set()`/`.add()` is not intercepted (the same category of limitation as array mutation) — only the state at the moment of crossing a boundary is checked.

## [0.1.1] - 2026-10-17

A real NestJS + TypeORM project was upgraded to 0.1.0 and its full test suite rerun, surfacing two bugs in the coverage this release had just added.

### Fixed

- `installFieldGuard` silently gave up — installing no guard at all — for any field that keeps its `PropertyDeclaration` in the output (every decorated field, to preserve decorator emission) and has no inline initializer: native class fields (target ES2022+) pre-define such a field as `undefined` before the constructor body runs, and that pre-defined, still-uninitialized placeholder was mistaken for "something else already initialized this field, leave it alone." In practice this left every field of a typical `class CreateUserDto { @IsString() name: string; constructor(data) { this.name = data.name; } }` — the common pattern of assigning fields inside the constructor body rather than inline — completely unguarded, decorated or not.
- A class field whose own type is a pure function (e.g. `class WithHandler { onClick: () => void = () => {}; }`) never had a guard installed at all: the `function` leaf added in 0.1.0 was only wired into the path used when a property is resolved as part of its *containing object's* structural shape, not into the general resolution path a field's own top-level contract candidate goes through to build its `installFieldGuard` call. A property/interface member with a callback type (fixed in 0.1.0) was unaffected; only a *class field's own* candidate took the unpatched path.

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
