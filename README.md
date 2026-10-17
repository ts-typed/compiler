# @ts-typed/compiler

`@ts-typed/compiler` instruments a TypeScript project so runtime values are checked against materializable TypeScript contracts. Its CLI is named `ts-typed`.

```bash
npm install --save-dev @ts-typed/compiler
npx ts-typed init
npx ts-typed build
```

The generated `typets.config.json` supports runtime-contract policy, diagnostics and ncc bundling. Unsupported runtime contracts warn by default; set `compiler.onUnsupported` to `"error"` for strict coverage.

See the repository `README.md` and `docs/SPEC.md` for supported behavior and known compatibility limits. Licensed under Apache-2.0.
