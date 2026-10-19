# @ts-typed/compiler

`@ts-typed/compiler` instruments a TypeScript project so runtime values are checked against the same types the compiler already knows about. No schema definitions, no decorators required for the basics — write normal TypeScript, and a transform pass inserts the runtime checks for you.

```bash
npm install --save-dev @ts-typed/compiler
npx ts-typed init
npx ts-typed build
```

- `ts-typed init` creates `typets.config.json` in the current project.
- `ts-typed build` runs the transform and emits the instrumented project to `outDir`.

Full behavior spec: [`docs/SPEC.md`](https://github.com/ts-typed/ts-typed/blob/main/docs/SPEC.md) in the [ts-typed/ts-typed](https://github.com/ts-typed/ts-typed) repository. Architecture notes: [`docs/architecture.md`](https://github.com/ts-typed/ts-typed/blob/main/docs/architecture.md).

## Table of contents

- [How it works](#how-it-works)
- [What gets checked](#what-gets-checked)
- [Error handling](#error-handling)
- [Configuration reference](#configuration-reference)
- [Decorators](#decorators)
- [Generics](#generics)
- [Path aliases (`tsconfig.json` `paths`)](#path-aliases-tsconfigjson-paths)
- [Known limitations](#known-limitations)

## How it works

The compiler walks your TypeScript project with the real TypeScript type checker, finds every place a value crosses a **typed boundary** — a variable declaration, a function parameter, a return statement, a class field assignment, a cast, a `satisfies` expression — and inserts a runtime check there, built from the *actual declared type* at that exact point. There is no separate schema language to maintain: the type you already wrote in TypeScript IS the contract.

If a value doesn't match, the check throws a `StrictTypeError` (a subclass of `TypeError`) instead of letting a wrong-shaped value quietly flow through your program.

## What gets checked

- **Primitives, literals, unions, intersections, tuples, template literal types** — including `bigint`, `symbol`, `null`/`undefined` distinguished correctly, and `NaN`/`Infinity` accepted as ordinary numbers (no domain checks).
- **Objects are closed by default**: an object with an extra, undeclared property fails (`EXTRA_PROPERTY`), stricter than plain TypeScript. Opt a class or property out with [`AllowExtraProperties()`](#allowextraproperties) or the `allowExtraPropertiesAll` config flag.
- **`Date`** is validated as a real `Date` instance, not just "any object."
- **Branded types** (`type UserId = string & { __brand: 'UserId' }`) are accepted at their underlying primitive type.
- **Classes**: `private`/`protected` fields (`compiler.enforcePrivate`), `readonly` fields (`compiler.enforceReadonly` — skipped for a field declared with `?` or `!`, so `class-transformer`-style post-construction population keeps working), required fields (locked non-configurable from the most-derived constructor onward — `delete`/`Object.defineProperty` bypass is blocked natively), and `static` fields.
- **Destructuring**: `const { age }: Profile = value;` validates the *whole source value* before extracting individual bindings.
- **Type guards and assertion functions**: a user-defined `x is T` validates its target when it returns `true`; `asserts x is T` / `asserts x` validates at every normal return path.
- **`Map`/`Set`/`ReadonlyMap`/`ReadonlySet`**: entries present when the collection crosses a boundary are validated against the declared key/value/item types. `WeakMap`/`WeakSet` are out of scope (see [Known limitations](#known-limitations)).
- **Generators, `async`/`await`**, and **explicit-generic calls and constructors** — see [Generics](#generics).
- **CommonJS module bindings**: an exported `let`/`var` gets a guard on the `exports` object itself, so an external write through the import namespace or another file's `require(...)` call is checked too.

## Error handling

Every violation throws a `StrictTypeError`:

```ts
class StrictTypeError extends TypeError {
  code: 'TYPE_MISMATCH' | 'EXTRA_PROPERTY' | 'REQUIRED_PROPERTY' | 'READONLY_PROPERTY' | 'INVALID_MUTATION';
  propertyPath: string;   // e.g. "CreateUserDto.email"
  expected: string;
  received: string;
  contractKind: 'variable' | 'parameter' | 'property' | 'return' | ...;
  operation: string;      // e.g. "initialize" | "set" | "argument" | "return" | "mutate"
  className?: string;
  functionName?: string;

  toJSON(): { code, propertyPath, expected, received, contractKind, operation, className?, functionName? };
}
```

`toJSON()` is deliberately the ONLY thing safe to send over the wire as-is: it never includes the raw value that failed validation, and never includes a stack trace. Some fields set by a decorator (see below) are intentionally excluded from `toJSON()` too, since they're meant for code catching the real exception object, not for a generic serialized body — [`@ts-typed/nestjs`](https://www.npmjs.com/package/@ts-typed/nestjs) is the reference consumer of those.

**ts-typed is fail-fast**: the first violation found throws immediately. It does not collect every violation across an object into one aggregated error the way some validation libraries do — see [Known limitations](#known-limitations).

## Configuration reference

`typets.config.json` (schema at `./node_modules/@ts-typed/compiler/schema.json`):

| Key | Default | Meaning |
|---|---|---|
| `entry` | `"src/main.ts"` | Project entry point. |
| `tsconfig` | `"tsconfig.json"` | TypeScript config to compile with. |
| `outDir` | `"dist"` | Output directory. |
| `integration` | `"typescript"` | Framework adapter (e.g. `"nestjs"`). |
| `allowExtraPropertiesAll` | `false` | Globally allow extra properties on every object boundary (same effect as `AllowExtraProperties()` everywhere). |
| `compiler.onUnsupported` | `"warn"` | `"warn"` or `"error"` when a type can't be given a runtime contract (e.g. a generic type parameter with no concrete type). |
| `compiler.strictClass` | `false` | Default nominal (`instanceof`) vs. structural validation for class-typed values. Override per class with [`StrictClass()`](#strictclass--structuralclass)/`StructuralClass()`. |
| `compiler.enforcePrivate` | `true` | Instrument `private`/`protected` class fields. |
| `compiler.enforceReadonly` | `true` | Lock a `readonly` class field after its first validated assignment (skipped for `?`/`!` fields). |
| `compiler.enforceClosedInstances` | `false` | **Opt-in.** Seal a class instance (`Object.preventExtensions`) once its most-derived constructor completes — no new property, string- or symbol-keyed, can be added afterward. See the warning below before enabling this. |
| `compiler.enforceMutationGuards` | `false` | **Opt-in.** Wrap an array/`Map`/`Set`/plain-object crossing a typed boundary in a `Proxy` that validates mutations (`push`/`splice`/index writes, `.set()`/`.add()`, `delete`/`defineProperty`, nested containers too) instead of only checking the value once at the boundary. |
| `compiler.sourceMap` | `true` | Emit source maps. |
| `diagnostics.format` | `"pretty"` | `"pretty"` or `"json"` coverage output. |
| `diagnostics.coverage` | `"summary"` | `"summary"` or `"detailed"`. |
| `diagnostics.reportFile` | `null` | Write the coverage report to a file instead of stdout. |
| `ncc.*` | — | Bundling options (passed through to `@vercel/ncc`): `enabled`, `minify`, `target`, `externals`, `cache`, `license`, `quiet`, `debugLog`. |

### About the two opt-in flags

Both `enforceClosedInstances` and `enforceMutationGuards` are off by default because they trade off against other libraries' own conventions, not because they're half-finished:

- **`enforceClosedInstances`** conflicts with the extremely common NestJS pattern of `class-transformer` + `ValidationPipe({ whitelist: true })`, which copies every key from a request body onto a `new Dto()` instance *first*, and only strips non-whitelisted keys *afterward*. Sealing the instance makes that first copy throw before the whitelist step ever runs. If you enable this flag, you must also configure `class-transformer` to only ever write declared keys in the first place (e.g. `excludeExtraneousValues: true` with `@Expose()` decorators, instead of copy-then-strip).
- **`enforceMutationGuards`** wraps the value in a `Proxy`, which has a real per-mutation validation cost and changes the value's identity (the returned value is a proxy, not the original reference) — acceptable for many use cases, not something to turn on blindly everywhere.

**The governing rule for any ts-typed config flag that overlaps with another library's own setting: ts-typed's config decides the behavior, and the rest of your stack must be configured to agree with it.** A mismatch (e.g. `enforceClosedInstances: true` with `class-transformer` still doing copy-then-strip) is an application configuration bug, not a ts-typed bug.

## Decorators

Import from `@ts-typed/compiler`.

### `AllowExtraProperties()`

Class or property decorator. Allows extra, undeclared properties on that class (or that one property's value) — the per-target override for the global `allowExtraPropertiesAll` flag.

```ts
@AllowExtraProperties()
class LooseConfig { /* accepts any extra key */ }
```

### `StrictClass()` / `StructuralClass()`

Class decorator. Overrides `compiler.strictClass` for one class: `StrictClass()` forces nominal (`instanceof`) validation, `StructuralClass()` forces structural (shape-only) validation, regardless of the global default. Inherited by subclasses unless they override it themselves.

### `ServerPopulated()`

Class decorator. Marks a class whose instances are populated by the server/database, not by client input — the intended use is a TypeORM `@Entity()` class. A `StrictTypeError` thrown for one of that class's fields then carries `isServerPopulated: true` (never present in `toJSON()`). This is the compiler-side half of telling an Entity's corrupted field apart from a DTO's bad client input; [`@ts-typed/nestjs`](https://www.npmjs.com/package/@ts-typed/nestjs)'s `StrictTypeErrorFilter` reads this flag to answer HTTP 500 instead of 400.

```ts
@Entity({ name: 'todos' })
@ServerPopulated()
export class TodoEntity { /* ... */ }
```

### `TypeErrorResponse(message, status?)`

Property decorator. Attaches a custom, HTTP-facing message (and optional status code) to a specific field. A `StrictTypeError` thrown for that field then carries `typeErrorResponseMessage`/`typeErrorResponseStatus` (never present in `toJSON()`). On its own this package has no HTTP awareness — see [`@ts-typed/nestjs`](https://www.npmjs.com/package/@ts-typed/nestjs)'s `StrictTypeErrorFilter`/`StrictTypeHttpError` for how these fields turn into an actual HTTP response, as a per-property alternative to `class-validator`'s messages.

```ts
export class CreateUserDto {
  @TypeErrorResponse('Email inválido', 422)
  public readonly email!: string;
}
```

This is still a single-violation (fail-fast) mechanism, like the rest of ts-typed — it customizes the response for whichever one violation fires on that property, not an aggregate of every violation across the object.

## Generics

Calling a generic function or constructing a generic class validates both the arguments and the result against the concrete type for that call — whether the type argument is written explicitly or left for TypeScript to infer:

```ts
function identity<T>(x: T): T { return x; }

identity<Person>(wrongShapedValue); // throws StrictTypeError, validated against Person
identity(wrongShapedValue);         // same check: T is inferred from the argument's own type
new Box<Person>(wrongShapedValue);  // same, for constructors
new Box(wrongShapedValue);          // and for an inferred constructor call
```

The inferred case uses the exact same instantiated signature TypeScript itself resolves for that call site (the same one a hover tooltip shows) — so it also covers `T` driven purely by a contextual/expected type when no argument pins it down:

```ts
function response<T>(data: T): IResponse<T> {
  return { data } as IResponse<T>;
}

const user: User = { name: 'Ada', age: 36 };
const result = response(user); // T inferred as User from `user` itself — validates the full IResponse<User> shape
```

This also covers:
- An `async` function's resolved return value (`identityAsync<Person>(x)` or its inferred form — validated via `.then()`, so the call stays a `Promise`; a failed check rejects it, consistent with how any other async failure surfaces).
- Rest parameters and spread arguments landing in them (`collect<number>(1, 2, 'bad')`, `collect<number>(...mixed)`, and their inferred forms).

If inference can't pin `T` down to anything concrete (no argument references it and no contextual type is available), TypeScript resolves it to `unknown`, and that's treated the same as any other unsupported type: no contract is generated, rather than validating against the wrong thing. A method whose generic declaration lives in one of TypeScript's own bundled lib files (`Array.prototype.map`, `Promise.resolve`, `Map`/`Set`'s own methods, etc.) is deliberately excluded — guarding those would mean instrumenting essentially every array/collection operation in a project, far outside this feature's intended scope of the project's OWN generic functions and classes, and some of those built-ins (`Map`/`Set`) already get their own dedicated, purpose-built handling elsewhere (entry validation, `compiler.enforceMutationGuards`). Generators' yielded values aren't validated either (a generator call produces an iterator, not a single return value).

## Path aliases (`tsconfig.json` `paths`)

A project organized with `paths` aliases (`@app/*` -> `src/*`, and similar) works out of the box — no separate runtime resolver needed:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@app/*": ["src/*"] }
  }
}
```

```ts
import { createUser } from '@app/users/create-user';
```

TypeScript itself never rewrites an aliased specifier in the JavaScript it emits — `paths` only ever affected the type checker and your editor, so a plain `tsc` build (or a bundler that doesn't understand tsconfig `paths`, like `@vercel/ncc`) would emit a literal `require('@app/users/create-user')` that Node can't resolve, failing with "Cannot find module" the first time that line actually runs. The compiler resolves every aliased `import`/`export ... from`/`require()`/dynamic `import()` the same way the checker already does (so it can never disagree with what type-checked) and rewrites it to a plain relative path at build time — in both the unbundled output and the `ncc`-bundled one, since by the time `ncc` sees the file the import is already an ordinary relative path, exactly like one you'd have written by hand.

If an alias can't be turned into something runtime-resolvable — nothing on disk actually matches it, or it resolves only to a `.d.ts` declaration file with no JavaScript behind it — the build fails up front with a precise `file:line:column` pointer per occurrence, instead of silently emitting something that breaks later.

## Known limitations

These are deliberate, documented scope boundaries, not oversights:

- **Multiple violations aren't aggregated.** ts-typed validates and populates an object field-by-field, throwing on the first bad field — unlike `class-validator`'s "populate everything, then validate the whole object in one pass, collecting every violation" model. If you need every violation in one response, you'll need to keep (or reintroduce) that kind of aggregate validation yourself for now.
- **`WeakMap`/`WeakSet`** are unsupported at the schema level (not just unprotected at runtime) — they can't be iterated, so there's nothing to validate at a boundary crossing.
- **AMD/UMD/System module output**, and the `let x; export { x };` list form, aren't covered by the CommonJS `exports` guard (ESM needs no equivalent — module namespace objects are already non-writable by spec).
- **Mutation guards only wrap the boundary-crossing value and its nested containers** at the moment the guard was created or a new value is written through it — a raw reference taken *before* the boundary, or a `Set`'s pre-existing items (which can't be swapped without changing iteration order), bypass the guard.
- **Generic classes/methods with no call-expression form** (e.g. a generic value used only as a type annotation, never actually called or constructed) have nothing for the [Generics](#generics) support to attach to — there's no call site to resolve an instantiated signature from.

## License

Apache-2.0
