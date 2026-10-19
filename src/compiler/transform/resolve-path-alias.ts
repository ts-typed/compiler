import { dirname, relative, sep } from 'node:path';
import type ts from 'typescript';

/**
 * TypeScript's own emitter never rewrites a `paths`-aliased module specifier (`@app/*` -> `src/*`
 * and similar) in the JavaScript it produces: the alias only exists for the compiler's own module
 * resolution and for editor tooling. An import written through an alias would emit a literal
 * `require('@app/foo')`/`import('@app/foo')` that Node (and `@vercel/ncc`, which bundles the
 * ALREADY-emitted JavaScript and has no idea what a tsconfig alias is either) cannot resolve. This
 * module resolves an aliased specifier to the real file on disk, using the exact same algorithm
 * (`ts.resolveModuleName`, which reads `compilerOptions.paths`/`baseUrl`) the checker itself used
 * to make the import type-check in the first place — so "resolves here" can never disagree between
 * the type checker and this rewrite. The caller turns the result into a relative specifier, which
 * needs no special handling from `@vercel/ncc` either: by the time ncc sees the file, the import is
 * already an ordinary relative path, exactly like one a developer would have written by hand.
 */

export type PathAliasResolution =
  | { readonly kind: 'not-aliased' }
  | { readonly kind: 'resolved'; readonly relativeSpecifier: string }
  | { readonly kind: 'unresolvable'; readonly reason: string };

/**
 * Resolves `specifierText`, written in `containingFileName`, against `compilerOptions.paths`, and
 * returns the specifier to emit in its place. `{ kind: 'not-aliased' }` means the caller should
 * leave the original specifier untouched (it was already relative, or it didn't match any `paths`
 * pattern, or it resolved into `node_modules` the normal way despite matching a pattern — Node's
 * own `require()` already handles that case without help). `{ kind: 'unresolvable' }` means the
 * specifier does use `paths` but could not be turned into something `require()`/`import()` can
 * actually load at runtime (nothing on disk resolves it, or it resolves only to a `.d.ts`
 * declaration file with no runtime module backing it) — the caller surfaces this as a build error
 * rather than silently emitting a specifier that would fail with "Cannot find module".
 */
export function resolvePathAliasSpecifier(
  typescript: typeof import('typescript'),
  compilerOptions: ts.CompilerOptions,
  specifierText: string,
  containingFileName: string,
): PathAliasResolution {
  if (specifierText.startsWith('.') || specifierText.startsWith('/')) {
    return { kind: 'not-aliased' };
  }
  if (compilerOptions.paths === undefined || Object.keys(compilerOptions.paths).length === 0) {
    return { kind: 'not-aliased' };
  }

  const matchesAPattern = Object.keys(compilerOptions.paths).some((pattern) =>
    matchesPathPattern(pattern, specifierText),
  );
  if (!matchesAPattern) {
    return { kind: 'not-aliased' };
  }

  const result = typescript.resolveModuleName(specifierText, containingFileName, compilerOptions, typescript.sys);
  const resolvedModule = result.resolvedModule;
  if (resolvedModule === undefined) {
    return { kind: 'unresolvable', reason: `"${specifierText}" matches a "paths" entry but does not resolve to a file on disk.` };
  }
  if (resolvedModule.isExternalLibraryImport === true) {
    // Resolved into node_modules despite matching a pattern: Node's own require() already
    // resolves a bare specifier like this without any rewrite.
    return { kind: 'not-aliased' };
  }
  if (resolvedModule.resolvedFileName.endsWith('.d.ts')) {
    return {
      kind: 'unresolvable',
      reason: `"${specifierText}" resolves only to a declaration file (${resolvedModule.resolvedFileName}), which has no JavaScript to require at runtime.`,
    };
  }

  return { kind: 'resolved', relativeSpecifier: toRelativeSpecifier(containingFileName, resolvedModule.resolvedFileName) };
}

/** `tsconfig.json` `paths` key syntax: an exact match, or exactly one `*` wildcard. */
function matchesPathPattern(pattern: string, specifierText: string): boolean {
  const starIndex = pattern.indexOf('*');
  if (starIndex === -1) {
    return pattern === specifierText;
  }
  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  return specifierText.startsWith(prefix) && specifierText.endsWith(suffix) && specifierText.length >= prefix.length + suffix.length;
}

/** Strips a TypeScript source extension and converts to a POSIX-style `./`-relative specifier. */
function toRelativeSpecifier(containingFileName: string, resolvedFileName: string): string {
  const withoutExtension = resolvedFileName.replace(/\.(tsx|ts|mts|cts)$/, '');
  let specifier = relative(dirname(containingFileName), withoutExtension).split(sep).join('/');
  if (!specifier.startsWith('.')) {
    specifier = `./${specifier}`;
  }
  return specifier;
}

/** Replaces `specifierNode` with its resolved relative form; returns it unchanged if not aliased. */
export function rewriteAliasedSpecifier(
  typescript: typeof import('typescript'),
  factory: ts.NodeFactory,
  compilerOptions: ts.CompilerOptions,
  specifierNode: ts.StringLiteral,
  containingFileName: string,
): ts.StringLiteral {
  const resolution = resolvePathAliasSpecifier(typescript, compilerOptions, specifierNode.text, containingFileName);
  return resolution.kind === 'resolved' ? factory.createStringLiteral(resolution.relativeSpecifier) : specifierNode;
}

/**
 * Scans every project source file (skipping declaration files and anything under `node_modules`,
 * via the same `isOutsideProject` predicate `buildProject` already uses for its emit loop) for a
 * `paths`-aliased specifier that cannot be turned into a runtime-resolvable path, and returns one
 * formatted `file:line:column: reason` string per occurrence. Called BEFORE the contract
 * transformer runs, so the build fails with a precise, actionable list up front instead of emitting
 * JavaScript that would fail at runtime with "Cannot find module" the first time that import path
 * actually executes.
 */
export function findUnresolvableAliasedSpecifiers(
  typescript: typeof import('typescript'),
  program: ts.Program,
  isOutsideProject: (fileName: string) => boolean,
): string[] {
  const compilerOptions = program.getCompilerOptions();
  const errors: string[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || isOutsideProject(sourceFile.fileName)) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      const specifierNode = extractModuleSpecifierNode(typescript, node);
      if (specifierNode !== undefined) {
        const resolution = resolvePathAliasSpecifier(typescript, compilerOptions, specifierNode.text, sourceFile.fileName);
        if (resolution.kind === 'unresolvable') {
          const position = sourceFile.getLineAndCharacterOfPosition(specifierNode.getStart(sourceFile));
          errors.push(`${sourceFile.fileName}:${position.line + 1}:${position.character + 1}: ${resolution.reason}`);
        }
      }
      typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return errors;
}

function extractModuleSpecifierNode(typescript: typeof import('typescript'), node: ts.Node): ts.StringLiteral | undefined {
  if (typescript.isImportDeclaration(node) && typescript.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier;
  }
  if (
    typescript.isExportDeclaration(node) &&
    node.moduleSpecifier !== undefined &&
    typescript.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  if (
    typescript.isImportEqualsDeclaration(node) &&
    typescript.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression !== undefined &&
    typescript.isStringLiteral(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression;
  }
  if (typescript.isCallExpression(node) && node.arguments.length >= 1 && typescript.isStringLiteral(node.arguments[0])) {
    const isRequireCall = typescript.isIdentifier(node.expression) && node.expression.text === 'require';
    const isDynamicImport = node.expression.kind === typescript.SyntaxKind.ImportKeyword;
    if (isRequireCall || isDynamicImport) {
      return node.arguments[0] as ts.StringLiteral;
    }
  }
  return undefined;
}
