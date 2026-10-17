import type ts from 'typescript';

import type { ContractDescriptor, CoverageDiagnostic } from '../analysis';
import type { Schema } from '../../runtime';
import type { ContractTransformerOptions } from './contract-transformer-options.interface';
import { createSchemaExpression } from './schema-expression';

const DEFAULT_RUNTIME_MODULE = '@ts-typed/compiler';
const LEGACY_RUNTIME_MODULE = 'ts-typed';
const UNSUPPORTED_SYNTAX_CODE = 'TT_UNSUPPORTED_SYNTAX';

interface FunctionVisitState {
  readonly declaration: ts.FunctionLikeDeclaration;
  readonly descriptor?: ContractDescriptor;
  readonly schema?: Schema;
  readonly isAsync: boolean;
  readonly name: string;
}

interface FieldGuard {
  readonly descriptor: ContractDescriptor;
  readonly key: ts.Expression;
  readonly initialized: boolean;
  readonly schema: Schema;
  readonly readonlyField: boolean;
}

interface PrivateConversion {
  readonly accessorName: string;
  readonly backingName: string;
}

interface FileTransformState {
  readonly sourceFile: ts.SourceFile;
  readonly runtimeIdentifier: ts.Identifier;
  readonly registryIdentifier: ts.Identifier;
  readonly runtimeModule: string;
  readonly handledContracts: Set<ContractDescriptor>;
  readonly diagnostics: Set<string>;
  readonly functionStack: FunctionVisitState[];
  readonly privateConversions: Map<ts.Symbol, PrivateConversion>;
}

export function createContractTransformer(
  options: ContractTransformerOptions,
): ts.TransformerFactory<ts.SourceFile> {
  const typescript = options.analysis.typescript;
  const checker = options.analysis.checker;
  const variableContracts = collectVariableContracts(typescript, options);

  return (context: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    const factory = context.factory;

    return (sourceFile: ts.SourceFile): ts.SourceFile => {
      if (sourceFile.isDeclarationFile) {
        return sourceFile;
      }

      const state: FileTransformState = {
        sourceFile,
        runtimeIdentifier: factory.createUniqueName('__tsTypedRuntime'),
        registryIdentifier: factory.createUniqueName('__tsTypedRegistry'),
        runtimeModule: resolveRuntimeModule(options.runtimeModule, sourceFile),
        handledContracts: new Set<ContractDescriptor>(),
        diagnostics: new Set<string>(),
        functionStack: [],
        privateConversions: options.enforcePrivate === true
          ? collectPrivateFieldConversions(sourceFile, typescript, checker, options)
          : new Map<ts.Symbol, PrivateConversion>(),
      };
      stateOptions.set(state, options);

      const visitor: ts.Visitor = (node: ts.Node): ts.VisitResult<ts.Node> => {
        if (typescript.isPropertyAccessExpression(node) && state.privateConversions.size > 0) {
          const converted = rewritePrivateAccess(node, state, factory, typescript, checker, visitor, context);
          if (converted !== undefined) {
            return converted;
          }
        }
        if (typescript.isImportDeclaration(node)) {
          return visitImportDeclaration(node, state, factory, typescript, visitor, context);
        }
        if (typescript.isExportDeclaration(node)) {
          return visitExportDeclaration(node, state, factory, typescript, visitor, context);
        }
        if (typescript.isImportEqualsDeclaration(node)) {
          return visitImportEqualsDeclaration(node, state, factory, typescript, visitor, context);
        }
        if (typescript.isCallExpression(node)) {
          return visitCallExpression(node, state, factory, typescript, visitor, context);
        }
        if (typescript.isClassDeclaration(node)) {
          return visitClassDeclaration(node, state, factory, typescript, visitor, context);
        }
        if (typescript.isClassExpression(node)) {
          return visitClassExpression(node, state, factory, typescript, visitor, context);
        }
        if (typescript.isVariableDeclaration(node)) {
          return visitVariableDeclaration(node, state, factory, typescript, visitor, context);
        }
        if (typescript.isBinaryExpression(node)) {
          return visitBinaryExpression(
            node,
            state,
            factory,
            typescript,
            checker,
            variableContracts,
            visitor,
            context,
          );
        }
        if (
          typescript.isAsExpression(node) ||
          typescript.isTypeAssertionExpression(node) ||
          typescript.isNonNullExpression(node) ||
          typescript.isSatisfiesExpression(node)
        ) {
          return visitContractExpression(node, state, factory, typescript, visitor, context);
        }
        if (typescript.isReturnStatement(node)) {
          return visitReturnStatement(node, state, factory, typescript, visitor, context);
        }
        if (isFunctionLikeWithBody(typescript, node)) {
          return visitFunctionLike(node, state, factory, typescript, checker, visitor, context);
        }
        return typescript.visitEachChild(node, visitor, context);
      };

      const visited = typescript.visitEachChild(sourceFile, visitor, context);
      reportUnhandledContracts(options, state);
      return addRuntimePrelude(visited, state, factory, typescript, options);
    };
  };
}

/**
 * Finds every `private` field in the file eligible for conversion into a
 * real `#private` field and builds its name mapping up front, before any
 * node is visited. True private names can only be introduced by rewriting
 * every reference to them throughout the declaring class's body — wherever
 * that reference sits relative to the declaration itself — so this has to
 * be resolved by symbol identity ahead of time rather than discovered
 * incrementally while descending through class members in declaration
 * order. Throws synchronously (failing the whole build, by design) if any
 * such field is ever accessed through bracket notation anywhere in the
 * program: that pattern has no `#private` equivalent, and there is no way
 * to preserve it while still converting the field.
 */
function collectPrivateFieldConversions(
  sourceFile: ts.SourceFile,
  typescript: typeof import('typescript'),
  checker: ts.TypeChecker,
  options: ContractTransformerOptions,
): Map<ts.Symbol, PrivateConversion> {
  const conversions = new Map<ts.Symbol, PrivateConversion>();
  const visit = (node: ts.Node): void => {
    if (
      typescript.isPropertyDeclaration(node) &&
      typescript.isIdentifier(node.name) &&
      isOnlyPrivateField(typescript, node)
    ) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol !== undefined) {
        const conflicts = options.analysis.privateBracketAccessConflicts.get(symbol);
        if (conflicts !== undefined && conflicts.length > 0) {
          const location = conflicts[0];
          throw new Error(
            `compiler.enforcePrivate cannot convert "${node.name.text}" (declared at ` +
            `${sourceFile.fileName}) to a real #private field: it is accessed through bracket ` +
            `notation at ${location.file}:${location.line}:${location.column}, which has no ` +
            '#private equivalent. Remove that access pattern or disable compiler.enforcePrivate.',
          );
        }
        conversions.set(symbol, {
          accessorName: `#${node.name.text}`,
          backingName: `#${node.name.text}$storage`,
        });
      }
    }
    typescript.forEachChild(node, visit);
  };
  typescript.forEachChild(sourceFile, visit);
  return conversions;
}

function isOnlyPrivateField(
  typescript: typeof import('typescript'),
  node: ts.PropertyDeclaration,
): boolean {
  const flags = typescript.getCombinedModifierFlags(node);
  return (flags & typescript.ModifierFlags.Private) !== 0 &&
    (flags & (typescript.ModifierFlags.Protected | typescript.ModifierFlags.Static)) === 0;
}

function rewritePrivateAccess(
  node: ts.PropertyAccessExpression,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  checker: ts.TypeChecker,
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.PropertyAccessExpression | undefined {
  if (!typescript.isIdentifier(node.name)) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(node.name);
  if (symbol === undefined) {
    return undefined;
  }
  const conversion = state.privateConversions.get(symbol);
  if (conversion === undefined) {
    return undefined;
  }
  const visitedExpression = typescript.visitNode(node.expression, visitor, isExpression) ?? node.expression;
  return factory.updatePropertyAccessExpression(
    node,
    visitedExpression,
    factory.createPrivateIdentifier(conversion.accessorName),
  );
}

function visitVariableDeclaration(
  node: ts.VariableDeclaration,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.VariableDeclaration {
  const descriptor = getDescriptorForNode(node, state, typescript);
  const initializer = node.initializer === undefined
    ? undefined
    : typescript.visitNode(node.initializer, visitor, isExpression);
  if (descriptor === undefined || descriptor.resolution.schema === undefined || initializer === undefined) {
    return factory.updateVariableDeclaration(
      node,
      node.name,
      node.exclamationToken,
      node.type,
      initializer,
    );
  }
  if (!typescript.isIdentifier(node.name)) {
    reportUnsupported(optionsForState(state), state, descriptor, node, 'Destructuring bindings cannot be guarded without changing binding evaluation.');
    return factory.updateVariableDeclaration(
      node,
      node.name,
      node.exclamationToken,
      node.type,
      initializer,
    );
  }

  state.handledContracts.add(descriptor);
  return factory.updateVariableDeclaration(
    node,
    node.name,
    node.exclamationToken,
    node.type,
    createProtectCall(factory, state, descriptor.resolution.schema, initializer, descriptor, 'initialize'),
  );
}

function visitBinaryExpression(
  node: ts.BinaryExpression,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  checker: ts.TypeChecker,
  variableContracts: ReadonlyMap<ts.Symbol, ContractDescriptor>,
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.BinaryExpression {
  const left = typescript.visitNode(node.left, visitor, isExpression) ?? node.left;
  const right = typescript.visitNode(node.right, visitor, isExpression) ?? node.right;
  if (!typescript.isIdentifier(node.left)) {
    return factory.updateBinaryExpression(node, left, node.operatorToken, right);
  }

  const symbol = checker.getSymbolAtLocation(node.left);
  const descriptor = symbol === undefined ? undefined : variableContracts.get(symbol);
  if (descriptor === undefined || descriptor.resolution.schema === undefined) {
    return factory.updateBinaryExpression(node, left, node.operatorToken, right);
  }
  if (node.operatorToken.kind !== typescript.SyntaxKind.EqualsToken) {
    reportUnsupported(
      optionsForState(state),
      state,
      descriptor,
      node,
      'Compound assignments and increments cannot be guarded without changing coercion or evaluation order.',
    );
    return factory.updateBinaryExpression(node, left, node.operatorToken, right);
  }

  return factory.updateBinaryExpression(
    node,
    left,
    node.operatorToken,
    createProtectCall(factory, state, descriptor.resolution.schema, right, descriptor, 'set'),
  );
}

function visitContractExpression(
  node: ts.AsExpression | ts.TypeAssertion | ts.NonNullExpression | ts.SatisfiesExpression,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.Expression {
  const descriptor = getDescriptorForNode(node, state, typescript);
  const visited = typescript.visitEachChild(node, visitor, context) as ts.Expression;
  if (descriptor?.resolution.schema === undefined) {
    return visited;
  }
  state.handledContracts.add(descriptor);
  return createProtectCall(factory, state, descriptor.resolution.schema, visited, descriptor, 'assert');
}

function visitReturnStatement(
  node: ts.ReturnStatement,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.ReturnStatement {
  const expression = node.expression === undefined
    ? undefined
    : typescript.visitNode(node.expression, visitor, isExpression);
  const functionState = state.functionStack.at(-1);
  if (expression === undefined || functionState?.schema === undefined || functionState.descriptor === undefined) {
    return factory.updateReturnStatement(node, expression);
  }

  const value = functionState.isAsync
    ? factory.createAwaitExpression(expression)
    : expression;
  state.handledContracts.add(functionState.descriptor);
  return factory.updateReturnStatement(
    node,
    createProtectCall(
      factory,
      state,
      functionState.schema,
      value,
      functionState.descriptor,
      functionState.isAsync ? 'resolve' : 'return',
      functionState.name,
    ),
  );
}

function visitFunctionLike(
  node: ts.FunctionLikeDeclaration & { readonly body: ts.ConciseBody },
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  checker: ts.TypeChecker,
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.FunctionLikeDeclaration {
  const descriptor = getDescriptorForNode(node, state, typescript, 'return');
  const isAsync = hasModifier(typescript, node, typescript.SyntaxKind.AsyncKeyword);
  const functionName = getFunctionName(typescript, node);
  const returnSchema = getReturnSchema(node, descriptor, isAsync, checker, state, typescript);
  const functionState: FunctionVisitState = {
    declaration: node,
    descriptor,
    schema: returnSchema,
    isAsync,
    name: functionName,
  };
  state.functionStack.push(functionState);
  const parameters = node.parameters.map((parameter) =>
    typescript.visitEachChild(parameter, visitor, context) as ts.ParameterDeclaration,
  );
  let body = typescript.visitNode(node.body, visitor, isConciseBody) ?? node.body;
  state.functionStack.pop();

  const parameterGuards = createParameterGuards(parameters, node.parameters, state, factory, typescript);
  if (typescript.isBlock(body)) {
    body = factory.updateBlock(body, [...parameterGuards, ...body.statements]);
  } else {
    if (returnSchema !== undefined && descriptor !== undefined) {
      const value = isAsync ? factory.createAwaitExpression(body) : body;
      body = createProtectCall(
        factory,
        state,
        returnSchema,
        value,
        descriptor,
        isAsync ? 'resolve' : 'return',
        functionName,
      );
      state.handledContracts.add(descriptor);
    }
    if (parameterGuards.length > 0) {
      body = factory.createBlock(
        [...parameterGuards, factory.createReturnStatement(body)],
        true,
      );
    }
  }

  return updateFunctionLike(factory, typescript, node, parameters, body);
}

function createParameterGuards(
  parameters: readonly ts.ParameterDeclaration[],
  originalParameters: readonly ts.ParameterDeclaration[],
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
): ts.Statement[] {
  const statements: ts.Statement[] = [];
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index];
    const original = originalParameters[index];
    const descriptor = getDescriptorForNode(original, state, typescript, 'parameter');
    if (descriptor?.resolution.schema === undefined) {
      continue;
    }
    if (!typescript.isIdentifier(parameter.name) || isThisParameter(typescript, parameter)) {
      reportUnsupported(
        optionsForState(state),
        state,
        descriptor,
        original,
        'Destructured and this parameters have no stable runtime binding for validation.',
      );
      continue;
    }
    state.handledContracts.add(descriptor);
    statements.push(
      factory.createExpressionStatement(
        createProtectCall(
          factory,
          state,
          descriptor.resolution.schema,
          parameter.name,
          descriptor,
          'argument',
        ),
      ),
    );
  }
  return statements;
}

function visitClassDeclaration(
  node: ts.ClassDeclaration,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.ClassDeclaration {
  const members = visitClassMembers(node, state, factory, typescript, visitor, context);
  return factory.updateClassDeclaration(
    node,
    node.modifiers,
    node.name,
    node.typeParameters,
    node.heritageClauses,
    members,
  );
}

function visitClassExpression(
  node: ts.ClassExpression,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.ClassExpression {
  const members = visitClassMembers(node, state, factory, typescript, visitor, context);
  return factory.updateClassExpression(
    node,
    node.modifiers,
    node.name,
    node.typeParameters,
    node.heritageClauses,
    members,
  );
}

function visitClassMembers(
  node: ts.ClassLikeDeclaration,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): readonly ts.ClassElement[] {
  const guards: FieldGuard[] = [];
  const visitedMembers: ts.ClassElement[] = [];
  const privateInitStatements: ts.Statement[] = [];
  const privateLockStatements: ts.Statement[] = [];
  let implementationConstructor: ts.ConstructorDeclaration | undefined;
  const checker = optionsForState(state).analysis.checker;

  for (const member of node.members) {
    if (typescript.isPropertyDeclaration(member)) {
      const privateConversion = typescript.isIdentifier(member.name)
        ? state.privateConversions.get(checker.getSymbolAtLocation(member.name) as ts.Symbol)
        : undefined;
      if (privateConversion !== undefined) {
        const descriptor = getDescriptorForNode(member, state, typescript, 'property');
        const converted = convertPrivateField(
          member,
          descriptor,
          privateConversion,
          state,
          factory,
          typescript,
          visitor,
          context,
        );
        visitedMembers.push(...converted.members);
        if (converted.constructorInitStatement !== undefined) {
          privateInitStatements.push(converted.constructorInitStatement);
        }
        if (converted.constructorLockStatement !== undefined) {
          privateLockStatements.push(converted.constructorLockStatement);
        }
        continue;
      }
      const descriptor = getDescriptorForNode(member, state, typescript, 'property');
      const transformed = visitPropertyDeclaration(
        member,
        descriptor,
        guards,
        state,
        factory,
        typescript,
        visitor,
        context,
      );
      if (transformed !== undefined) {
        visitedMembers.push(transformed);
      }
      continue;
    }
    if (typescript.isConstructorDeclaration(member) && member.body !== undefined) {
      const transformed = typescript.visitEachChild(member, visitor, context) as ts.ConstructorDeclaration;
      implementationConstructor = transformed;
      visitedMembers.push(transformed);
      continue;
    }
    visitedMembers.push(typescript.visitEachChild(member, visitor, context) as ts.ClassElement);
  }

  if (guards.length === 0 && privateInitStatements.length === 0 && privateLockStatements.length === 0) {
    return visitedMembers;
  }

  const isDerived = node.heritageClauses?.some(
    (clause) => clause.token === typescript.SyntaxKind.ExtendsKeyword,
  ) === true;
  const installStatements = [
    ...guards.map((guard) => createInstallFieldGuard(factory, state, guard)),
    ...privateInitStatements,
  ];
  const lockStatements = [
    ...guards.filter((guard) => guard.readonlyField).map((guard) => createLockReadonlyFieldCall(factory, state, guard)),
    ...privateLockStatements,
  ];
  if (implementationConstructor === undefined) {
    const constructor = createConstructor(factory, installStatements, lockStatements, isDerived, typescript);
    return [...visitedMembers, constructor];
  }

  const constructorIndex = visitedMembers.indexOf(implementationConstructor);
  const updatedConstructor = insertConstructorGuards(
    implementationConstructor,
    installStatements,
    lockStatements,
    isDerived,
    state,
    factory,
    typescript,
    guards,
  );
  visitedMembers[constructorIndex] = updatedConstructor;
  return visitedMembers;
}

interface ConvertedPrivateField {
  readonly members: readonly ts.ClassElement[];
  readonly constructorInitStatement?: ts.Statement;
  readonly constructorLockStatement?: ts.Statement;
}

/**
 * Converts a TypeScript `private` field into a real ECMAScript `#private`
 * field. Unlike a guarded public field (installed reflectively at runtime
 * via `installFieldGuard`), a true private name only exists through literal
 * `#name` syntax written directly in the class body — there is no runtime
 * API that can create, read or write one. So this field gets a private
 * backing store plus a same-named private accessor pair, synthesized here
 * as real class members, with validation calls inlined into the setter
 * body instead of delegated to the shared guard registry.
 */
function convertPrivateField(
  node: ts.PropertyDeclaration,
  descriptor: ContractDescriptor | undefined,
  conversion: PrivateConversion,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ConvertedPrivateField {
  const initializer = node.initializer === undefined
    ? undefined
    : typescript.visitNode(node.initializer, visitor, isExpression);
  const schema = descriptor?.resolution.schema;
  const readonlyField = optionsForState(state).enforceReadonly === true
    && hasModifier(typescript, node, typescript.SyntaxKind.ReadonlyKeyword);

  const backingName = factory.createPrivateIdentifier(conversion.backingName);
  const accessorName = factory.createPrivateIdentifier(conversion.accessorName);
  const lockedName = factory.createPrivateIdentifier(`${conversion.backingName}$locked`);

  const members: ts.ClassElement[] = [
    factory.createPropertyDeclaration(undefined, backingName, undefined, node.type, undefined),
  ];
  if (readonlyField) {
    members.push(
      factory.createPropertyDeclaration(undefined, lockedName, undefined, undefined, factory.createFalse()),
    );
  }

  const valueParameterName = factory.createUniqueName('value');
  const setterStatements: ts.Statement[] = [];
  if (readonlyField) {
    setterStatements.push(
      factory.createIfStatement(
        factory.createPropertyAccessExpression(factory.createThis(), lockedName),
        factory.createBlock([createThrowReadonlyStatement(factory, state, descriptor)], true),
      ),
    );
  }
  const storedValue = schema === undefined || descriptor === undefined
    ? (valueParameterName as ts.Expression)
    : createProtectCall(factory, state, schema, valueParameterName, descriptor, 'set');
  setterStatements.push(
    factory.createExpressionStatement(
      factory.createBinaryExpression(
        factory.createPropertyAccessExpression(factory.createThis(), backingName),
        factory.createToken(typescript.SyntaxKind.EqualsToken),
        storedValue,
      ),
    ),
  );

  members.push(
    factory.createGetAccessorDeclaration(
      undefined,
      accessorName,
      [],
      undefined,
      factory.createBlock(
        [factory.createReturnStatement(factory.createPropertyAccessExpression(factory.createThis(), backingName))],
        true,
      ),
    ),
    factory.createSetAccessorDeclaration(
      undefined,
      accessorName,
      [
        factory.createParameterDeclaration(undefined, undefined, valueParameterName, undefined, undefined, undefined),
      ],
      factory.createBlock(setterStatements, true),
    ),
  );

  if (descriptor !== undefined) {
    state.handledContracts.add(descriptor);
  }

  const constructorInitStatement = initializer === undefined
    ? undefined
    : factory.createExpressionStatement(
      factory.createBinaryExpression(
        factory.createPropertyAccessExpression(factory.createThis(), accessorName),
        factory.createToken(typescript.SyntaxKind.EqualsToken),
        initializer,
      ),
    );
  const constructorLockStatement = readonlyField
    ? factory.createExpressionStatement(
      factory.createBinaryExpression(
        factory.createPropertyAccessExpression(factory.createThis(), lockedName),
        factory.createToken(typescript.SyntaxKind.EqualsToken),
        factory.createTrue(),
      ),
    )
    : undefined;

  return {
    members,
    ...(constructorInitStatement === undefined ? {} : { constructorInitStatement }),
    ...(constructorLockStatement === undefined ? {} : { constructorLockStatement }),
  };
}

function createThrowReadonlyStatement(
  factory: ts.NodeFactory,
  state: FileTransformState,
  descriptor: ContractDescriptor | undefined,
): ts.Statement {
  const members: ts.ObjectLiteralElementLike[] = [
    factory.createPropertyAssignment('code', factory.createStringLiteral('READONLY_PROPERTY')),
    factory.createPropertyAssignment(
      'contractKind',
      factory.createStringLiteral(descriptor?.kind ?? 'property'),
    ),
    factory.createPropertyAssignment('propertyPath', factory.createStringLiteral(descriptor?.name ?? '<unknown>')),
    factory.createPropertyAssignment('expected', factory.createStringLiteral('no further writes')),
    factory.createPropertyAssignment('received', factory.createStringLiteral('write attempt')),
    factory.createPropertyAssignment('operation', factory.createStringLiteral('set')),
  ];
  return factory.createThrowStatement(
    factory.createNewExpression(
      factory.createPropertyAccessExpression(state.runtimeIdentifier, 'StrictTypeError'),
      undefined,
      [factory.createObjectLiteralExpression(members)],
    ),
  );
}

function visitPropertyDeclaration(
  node: ts.PropertyDeclaration,
  descriptor: ContractDescriptor | undefined,
  guards: FieldGuard[],
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.PropertyDeclaration | undefined {
  const initializer = node.initializer === undefined
    ? undefined
    : typescript.visitNode(node.initializer, visitor, isExpression);
  if (descriptor?.resolution.schema === undefined) {
    return factory.updatePropertyDeclaration(
      node,
      node.modifiers,
      node.name,
      node.questionToken ?? node.exclamationToken,
      node.type,
      initializer,
    );
  }

  const enforceReadonly = optionsForState(state).enforceReadonly === true;
  const unsupportedReason = getUnsupportedFieldReason(typescript, node, enforceReadonly);
  if (unsupportedReason !== undefined) {
    reportUnsupported(optionsForState(state), state, descriptor, node, unsupportedReason);
    return factory.updatePropertyDeclaration(
      node,
      node.modifiers,
      node.name,
      node.questionToken ?? node.exclamationToken,
      node.type,
      initializer,
    );
  }

  const key = createFieldKeyExpression(factory, typescript, node.name);
  if (key === undefined) {
    reportUnsupported(
      optionsForState(state),
      state,
      descriptor,
      node,
      'Computed field names cannot be evaluated again without changing program behavior.',
    );
    return factory.updatePropertyDeclaration(
      node,
      node.modifiers,
      node.name,
      node.questionToken ?? node.exclamationToken,
      node.type,
      initializer,
    );
  }

  guards.push({
    descriptor,
    key,
    initialized: initializer !== undefined,
    schema: descriptor.resolution.schema,
    readonlyField: enforceReadonly && hasModifier(typescript, node, typescript.SyntaxKind.ReadonlyKeyword),
  });
  state.handledContracts.add(descriptor);

  if (initializer === undefined && !hasDecorators(typescript, node)) {
    // Native class fields (target >= ES2022) define uninitialized fields as
    // `undefined` before the constructor body runs, including before the
    // installFieldGuard call inserted below. Omitting the declaration here
    // avoids that pre-definition clobbering the guard installation point.
    return undefined;
  }

  const protectedInitializer = initializer === undefined
    ? undefined
    : createProtectCall(
      factory,
      state,
      descriptor.resolution.schema,
      initializer,
      descriptor,
      'initialize',
    );
  return factory.updatePropertyDeclaration(
    node,
    node.modifiers,
    node.name,
    node.questionToken ?? node.exclamationToken,
    node.type,
    protectedInitializer,
  );
}

function hasDecorators(
  typescript: typeof import('typescript'),
  node: ts.PropertyDeclaration,
): boolean {
  return typescript.canHaveDecorators(node) &&
    (typescript.getDecorators(node)?.length ?? 0) > 0;
}

function insertConstructorGuards(
  node: ts.ConstructorDeclaration,
  installStatements: readonly ts.Statement[],
  lockStatements: readonly ts.Statement[],
  isDerived: boolean,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  guards: readonly FieldGuard[],
): ts.ConstructorDeclaration {
  if (node.body === undefined) {
    return node;
  }
  let insertionIndex = 0;
  if (isDerived) {
    const superIndex = node.body.statements.findIndex((statement) => isDirectSuperCall(typescript, statement));
    if (superIndex < 0) {
      for (const guard of guards) {
        state.handledContracts.delete(guard.descriptor);
        reportUnsupported(
          optionsForState(state),
          state,
          guard.descriptor,
          node,
          'A derived constructor without a direct top-level super() call cannot install field guards safely.',
        );
      }
      return node;
    }
    insertionIndex = superIndex + 1;
  }
  const remainingStatements = node.body.statements.slice(insertionIndex);
  const statements: ts.Statement[] = [
    ...node.body.statements.slice(0, insertionIndex),
    ...installStatements,
    // The remainder of the user's own constructor body is wrapped in
    // try/finally so the lock calls below always run exactly once this
    // constructor is done — including through an early `return;` or a
    // thrown error — matching TypeScript's own rule that a `readonly`
    // field may be (re)assigned any number of times while its declaring
    // class's constructor is still running, and never again afterward.
    ...(lockStatements.length === 0
      ? remainingStatements
      : [
        factory.createTryStatement(
          factory.createBlock(remainingStatements, true),
          undefined,
          factory.createBlock(lockStatements, true),
        ),
      ]),
  ];
  return factory.updateConstructorDeclaration(
    node,
    node.modifiers,
    node.parameters,
    factory.updateBlock(node.body, statements),
  );
}

function createConstructor(
  factory: ts.NodeFactory,
  installStatements: readonly ts.Statement[],
  lockStatements: readonly ts.Statement[],
  isDerived: boolean,
  typescript: typeof import('typescript'),
): ts.ConstructorDeclaration {
  if (!isDerived) {
    return factory.createConstructorDeclaration(
      undefined,
      [],
      factory.createBlock([...installStatements, ...lockStatements], true),
    );
  }
  const argumentsIdentifier = factory.createUniqueName('args');
  const parameter = factory.createParameterDeclaration(
    undefined,
    factory.createToken(typescript.SyntaxKind.DotDotDotToken),
    argumentsIdentifier,
    undefined,
    undefined,
    undefined,
  );
  const superStatement = factory.createExpressionStatement(
    factory.createCallExpression(factory.createSuper(), undefined, [
      factory.createSpreadElement(argumentsIdentifier),
    ]),
  );
  return factory.createConstructorDeclaration(
    undefined,
    [parameter],
    factory.createBlock([superStatement, ...installStatements, ...lockStatements], true),
  );
}

function createInstallFieldGuard(
  factory: ts.NodeFactory,
  state: FileTransformState,
  guard: FieldGuard,
): ts.Statement {
  const typescript = optionsForState(state).analysis.typescript;
  const allowExtraProperties = factory.createBinaryExpression(
    factory.createBinaryExpression(
      optionsForState(state).allowExtraPropertiesAll === true ? factory.createTrue() : factory.createFalse(),
      factory.createToken(typescript.SyntaxKind.BarBarToken),
      factory.createCallExpression(
        factory.createPropertyAccessExpression(state.runtimeIdentifier, 'isExtraPropertiesAllowed'),
        undefined,
        [factory.createThis()],
      ),
    ),
    factory.createToken(typescript.SyntaxKind.BarBarToken),
    factory.createCallExpression(
      factory.createPropertyAccessExpression(state.runtimeIdentifier, 'isExtraPropertiesAllowed'),
      undefined,
      [factory.createThis(), guard.key],
    ),
  );
  return factory.createExpressionStatement(
    factory.createCallExpression(
      factory.createPropertyAccessExpression(state.runtimeIdentifier, 'installFieldGuard'),
      undefined,
      [
        factory.createThis(),
        guard.key,
        createSchemaExpression(optionsForState(state).analysis.typescript, factory, guard.schema),
        createContextExpression(factory, state, guard.descriptor, 'set'),
        factory.createObjectLiteralExpression([
          factory.createPropertyAssignment(
            'initialized',
            guard.initialized ? factory.createTrue() : factory.createFalse(),
          ),
          factory.createPropertyAssignment('allowExtraProperties', allowExtraProperties),
          factory.createPropertyAssignment(
            'readonlyField',
            guard.readonlyField ? factory.createTrue() : factory.createFalse(),
          ),
        ]),
      ],
    ),
  );
}

function createLockReadonlyFieldCall(
  factory: ts.NodeFactory,
  state: FileTransformState,
  guard: FieldGuard,
): ts.Statement {
  return factory.createExpressionStatement(
    factory.createCallExpression(
      factory.createPropertyAccessExpression(state.runtimeIdentifier, 'lockReadonlyField'),
      undefined,
      [factory.createThis(), guard.key],
    ),
  );
}

function createProtectCall(
  factory: ts.NodeFactory,
  state: FileTransformState,
  schema: Schema,
  value: ts.Expression,
  descriptor: ContractDescriptor,
  operation: string,
  functionName?: string,
): ts.Expression {
  return factory.createCallExpression(
    factory.createPropertyAccessExpression(state.runtimeIdentifier, 'protectValue'),
    undefined,
    [
      createSchemaExpression(optionsForState(state).analysis.typescript, factory, schema),
      value,
      createContextExpression(factory, state, descriptor, operation, functionName),
    ],
  );
}

function createContextExpression(
  factory: ts.NodeFactory,
  state: FileTransformState,
  descriptor: ContractDescriptor,
  operation: string,
  functionName?: string,
): ts.ObjectLiteralExpression {
  const members: ts.ObjectLiteralElementLike[] = [
    factory.createPropertyAssignment('contractKind', factory.createStringLiteral(descriptor.kind)),
    factory.createPropertyAssignment('operation', factory.createStringLiteral(operation)),
    factory.createPropertyAssignment('propertyPath', factory.createStringLiteral(descriptor.name)),
    factory.createPropertyAssignment('registry', state.registryIdentifier),
  ];
  if (optionsForState(state).allowExtraPropertiesAll === true) {
    members.push(factory.createPropertyAssignment('allowExtraPropertiesAll', factory.createTrue()));
  }
  if (functionName !== undefined) {
    members.push(factory.createPropertyAssignment('functionName', factory.createStringLiteral(functionName)));
  }
  return factory.createObjectLiteralExpression(members);
}

const CLASS_VALIDATION_CODE = 'TT_UNSUPPORTED_SYNTAX';

interface DefinitionSchemaResult {
  readonly expression: ts.Expression;
  /**
   * Index, within the transformed file's top-level statements, of the class
   * declaration this definition's `instanceOf` reference points to. A
   * `registry.define(...)` call referencing a class must be placed after
   * that declaration (classes are not hoisted the way functions are;
   * referencing one earlier throws a temporal-dead-zone ReferenceError), so
   * this definition cannot stay in the prelude when this is set.
   */
  readonly deferAfterStatementIndex?: number;
}

function createDefinitionSchemaExpression(
  definitionName: string,
  schema: Schema,
  transformedStatements: readonly ts.Statement[],
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  options: ContractTransformerOptions,
): DefinitionSchemaResult {
  const base = createSchemaExpression(typescript, factory, schema);
  if (schema.kind !== 'object') {
    return { expression: base };
  }

  const classSymbol = options.analysis.resolver.getClassSymbol(definitionName);
  if (classSymbol === undefined) {
    return { expression: base };
  }

  const declaration = classSymbol.valueDeclaration ?? classSymbol.declarations?.[0];
  const isSameFile = declaration !== undefined
    && declaration.getSourceFile().fileName === state.sourceFile.fileName;
  const className = classSymbol.getName();
  const topLevelIndex = isSameFile
    ? transformedStatements.findIndex(
      (statement) => typescript.isClassDeclaration(statement) && statement.name?.text === className,
    )
    : -1;

  if (topLevelIndex === -1) {
    if (options.strictClass === true) {
      reportClassValidationLimit(
        options,
        state,
        className,
        isSameFile
          ? 'compiler.strictClass is enabled, but this class is not a top-level declaration in its file; the compiler cannot embed a live reference to it here, so this contract falls back to structural validation.'
          : 'compiler.strictClass is enabled, but this class is declared in a different file than its validation point; the compiler cannot embed a live reference to it here, so this contract falls back to structural validation.',
      );
    }
    return { expression: base };
  }

  const additionalProperties: ts.ObjectLiteralElementLike[] = [
    factory.createPropertyAssignment('instanceOf', factory.createIdentifier(className)),
    factory.createPropertyAssignment(
      'strictClassDefault',
      options.strictClass === true ? factory.createTrue() : factory.createFalse(),
    ),
  ];
  const expression = factory.createObjectLiteralExpression([
    ...(base as ts.ObjectLiteralExpression).properties,
    ...additionalProperties,
  ]);
  return { expression, deferAfterStatementIndex: topLevelIndex };
}

function reportClassValidationLimit(
  options: ContractTransformerOptions,
  state: FileTransformState,
  className: string,
  message: string,
): void {
  const diagnostic: CoverageDiagnostic = {
    code: CLASS_VALIDATION_CODE,
    category: 'warning',
    status: 'partial',
    file: state.sourceFile.fileName,
    line: 1,
    column: 1,
    name: className,
    kind: 'expression',
    message,
  };
  options.onDiagnostic?.(diagnostic);
}

function addRuntimePrelude(
  sourceFile: ts.SourceFile,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  options: ContractTransformerOptions,
): ts.SourceFile {
  // A plain `require()` call is used instead of an `import` declaration
  // because TypeScript only down-levels import/export syntax to CommonJS
  // for source files it already recognized as modules at parse time. A
  // file with no user-authored import/export (a "script") never gets that
  // down-level pass, so an injected `ImportDeclaration` would be emitted
  // verbatim as invalid ESM syntax inside a CommonJS "use strict" file.
  const runtimeImport = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          state.runtimeIdentifier,
          undefined,
          undefined,
          factory.createCallExpression(
            factory.createIdentifier('require'),
            undefined,
            [factory.createStringLiteral(state.runtimeModule)],
          ),
        ),
      ],
      typescript.NodeFlags.Const,
    ),
  );
  const registryDeclaration = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          state.registryIdentifier,
          undefined,
          undefined,
          factory.createNewExpression(
            factory.createPropertyAccessExpression(state.runtimeIdentifier, 'SchemaRegistry'),
            undefined,
            [],
          ),
        ),
      ],
      typescript.NodeFlags.Const,
    ),
  );
  const definitions = options.analysis.resolver.getDefinitions();
  const immediateDefinitionStatements: ts.Statement[] = [];
  const deferredDefinitionStatementsByIndex = new Map<number, ts.Statement[]>();

  for (const [name, schema] of Object.entries(definitions)) {
    const result = createDefinitionSchemaExpression(
      name,
      schema,
      sourceFile.statements,
      state,
      factory,
      typescript,
      options,
    );
    const defineStatement = factory.createExpressionStatement(
      factory.createCallExpression(
        factory.createPropertyAccessExpression(state.registryIdentifier, 'define'),
        undefined,
        [factory.createStringLiteral(name), result.expression],
      ),
    );
    if (result.deferAfterStatementIndex === undefined) {
      immediateDefinitionStatements.push(defineStatement);
      continue;
    }
    const existing = deferredDefinitionStatementsByIndex.get(result.deferAfterStatementIndex) ?? [];
    existing.push(defineStatement);
    deferredDefinitionStatementsByIndex.set(result.deferAfterStatementIndex, existing);
  }

  const lastImportIndex = findLastImportIndex(typescript, sourceFile.statements);
  const prelude = [runtimeImport, registryDeclaration, ...immediateDefinitionStatements];
  const statements: ts.Statement[] = [];
  if (lastImportIndex === -1) {
    statements.push(...prelude);
  }
  for (let index = 0; index < sourceFile.statements.length; index += 1) {
    statements.push(sourceFile.statements[index]);
    if (index === lastImportIndex) {
      statements.push(...prelude);
    }
    const deferred = deferredDefinitionStatementsByIndex.get(index);
    if (deferred !== undefined) {
      statements.push(...deferred);
    }
  }
  return factory.updateSourceFile(sourceFile, statements);
}

function reportUnhandledContracts(options: ContractTransformerOptions, state: FileTransformState): void {
  for (const descriptor of options.analysis.contracts.values()) {
    if (
      descriptor.sourceFile !== state.sourceFile ||
      descriptor.resolution.schema === undefined ||
      (descriptor.resolution.status !== 'protected' && descriptor.resolution.status !== 'partial') ||
      state.handledContracts.has(descriptor)
    ) {
      continue;
    }
    reportUnsupported(
      options,
      state,
      descriptor,
      descriptor.node,
      'No semantics-preserving instrumentation point is available for this protected contract.',
    );
  }
}

function reportUnsupported(
  options: ContractTransformerOptions,
  state: FileTransformState,
  descriptor: ContractDescriptor,
  node: ts.Node,
  reason: string,
): void {
  const position = state.sourceFile.getLineAndCharacterOfPosition(node.getStart(state.sourceFile));
  const key = `${node.pos}:${node.end}:${reason}`;
  if (state.diagnostics.has(key)) {
    return;
  }
  state.diagnostics.add(key);
  const diagnostic: CoverageDiagnostic = {
    code: UNSUPPORTED_SYNTAX_CODE,
    category: 'warning',
    status: descriptor.resolution.status === 'partial' ? 'partial' : 'unsupported',
    file: state.sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
    name: descriptor.name,
    kind: descriptor.kind,
    message: reason,
  };
  options.onDiagnostic?.(diagnostic);
}

function getDescriptorForNode(
  node: ts.Node,
  state: FileTransformState,
  typescript: typeof import('typescript'),
  kind?: ContractDescriptor['kind'],
): ContractDescriptor | undefined {
  const direct = optionsForState(state).analysis.contracts.get(node);
  if (direct !== undefined && (kind === undefined || direct.kind === kind)) {
    return direct;
  }
  if (kind === undefined) {
    return undefined;
  }
  for (const descriptor of optionsForState(state).analysis.contracts.values()) {
    if (descriptor.node === node && descriptor.kind === kind) {
      return descriptor;
    }
  }
  return undefined;
}

const stateOptions = new WeakMap<FileTransformState, ContractTransformerOptions>();

function optionsForState(state: FileTransformState): ContractTransformerOptions {
  const options = stateOptions.get(state);
  if (options === undefined) {
    throw new Error('Contract transformer state was not initialized.');
  }
  return options;
}

function collectVariableContracts(
  typescript: typeof import('typescript'),
  options: ContractTransformerOptions,
): ReadonlyMap<ts.Symbol, ContractDescriptor> {
  const contracts = new Map<ts.Symbol, ContractDescriptor>();
  for (const descriptor of options.analysis.contracts.values()) {
    if (
      descriptor.kind !== 'variable' ||
      !typescript.isVariableDeclaration(descriptor.node) ||
      !typescript.isIdentifier(descriptor.node.name)
    ) {
      continue;
    }
    const symbol = options.analysis.checker.getSymbolAtLocation(descriptor.node.name);
    if (symbol !== undefined) {
      contracts.set(symbol, descriptor);
    }
  }
  return contracts;
}

function getReturnSchema(
  node: ts.FunctionLikeDeclaration,
  descriptor: ContractDescriptor | undefined,
  isAsync: boolean,
  checker: ts.TypeChecker,
  state: FileTransformState,
  typescript: typeof import('typescript'),
): Schema | undefined {
  const signature = checker.getSignatureFromDeclaration(node);
  if (signature !== undefined) {
    const returnType = checker.getReturnTypeOfSignature(signature);
    if ((returnType.flags & typescript.TypeFlags.Void) !== 0) {
      if (descriptor !== undefined) {
        state.handledContracts.add(descriptor);
      }
      return undefined;
    }
  }
  if (!isAsync) {
    return descriptor?.resolution.schema;
  }
  if (signature === undefined) {
    return undefined;
  }
  const promised = checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
  if (promised === undefined) {
    if (descriptor !== undefined) {
      reportUnsupported(
        optionsForState(state),
        state,
        descriptor,
        node,
        'The async return type has no materializable awaited contract.',
      );
    }
    return undefined;
  }
  const resolution = optionsForState(state).analysis.resolver.resolve(promised, node);
  if (resolution.schema === undefined) {
    if (descriptor !== undefined) {
      reportUnsupported(
        optionsForState(state),
        state,
        descriptor,
        node,
        resolution.reason ?? 'The awaited return type is unsupported.',
      );
    }
    return undefined;
  }
  return resolution.schema;
}

function getUnsupportedFieldReason(
  typescript: typeof import('typescript'),
  node: ts.PropertyDeclaration,
  enforceReadonly: boolean,
): string | undefined {
  if (hasModifier(typescript, node, typescript.SyntaxKind.StaticKeyword)) {
    return 'Static fields do not have an instance guard installation point.';
  }
  if (typescript.isPrivateIdentifier(node.name)) {
    return '#private fields cannot be replaced with public property descriptors.';
  }
  if (hasModifier(typescript, node, typescript.SyntaxKind.DeclareKeyword)) {
    return 'declare fields do not create a runtime initialization point.';
  }
  if (!enforceReadonly && hasModifier(typescript, node, typescript.SyntaxKind.ReadonlyKeyword)) {
    return 'readonly fields cannot receive a persistent setter without changing their runtime surface.';
  }
  return undefined;
}

function createFieldKeyExpression(
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  name: ts.PropertyName,
): ts.Expression | undefined {
  if (typescript.isIdentifier(name) || typescript.isStringLiteral(name) || typescript.isNumericLiteral(name)) {
    return factory.createStringLiteral(name.text);
  }
  return undefined;
}

function visitImportDeclaration(
  node: ts.ImportDeclaration,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.ImportDeclaration {
  const visited = typescript.visitEachChild(node, visitor, context) as ts.ImportDeclaration;
  if (!shouldRewriteModule(typescript, visited.moduleSpecifier, state)) {
    return visited;
  }
  return factory.updateImportDeclaration(
    visited,
    visited.modifiers,
    visited.importClause,
    factory.createStringLiteral(state.runtimeModule),
    visited.attributes,
  );
}

function visitExportDeclaration(
  node: ts.ExportDeclaration,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.ExportDeclaration {
  const visited = typescript.visitEachChild(node, visitor, context) as ts.ExportDeclaration;
  if (visited.moduleSpecifier === undefined || !shouldRewriteModule(typescript, visited.moduleSpecifier, state)) {
    return visited;
  }
  return factory.updateExportDeclaration(
    visited,
    visited.modifiers,
    visited.isTypeOnly,
    visited.exportClause,
    factory.createStringLiteral(state.runtimeModule),
    visited.attributes,
  );
}

function visitImportEqualsDeclaration(
  node: ts.ImportEqualsDeclaration,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.ImportEqualsDeclaration {
  const visited = typescript.visitEachChild(node, visitor, context) as ts.ImportEqualsDeclaration;
  if (
    !typescript.isExternalModuleReference(visited.moduleReference) ||
    visited.moduleReference.expression === undefined ||
    !shouldRewriteModule(typescript, visited.moduleReference.expression, state)
  ) {
    return visited;
  }
  return factory.updateImportEqualsDeclaration(
    visited,
    visited.modifiers,
    visited.isTypeOnly,
    visited.name,
    factory.createExternalModuleReference(factory.createStringLiteral(state.runtimeModule)),
  );
}

function visitCallExpression(
  node: ts.CallExpression,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.CallExpression {
  const visited = typescript.visitEachChild(node, visitor, context) as ts.CallExpression;
  if (
    !typescript.isIdentifier(visited.expression) ||
    visited.expression.text !== 'require' ||
    visited.arguments.length !== 1 ||
    !shouldRewriteModule(typescript, visited.arguments[0], state)
  ) {
    return visited;
  }
  return factory.updateCallExpression(
    visited,
    visited.expression,
    visited.typeArguments,
    [factory.createStringLiteral(state.runtimeModule)],
  );
}

function shouldRewriteModule(
  typescript: typeof import('typescript'),
  expression: ts.Expression,
  state: FileTransformState,
): boolean {
  return state.runtimeModule !== DEFAULT_RUNTIME_MODULE &&
    typescript.isStringLiteral(expression) &&
    (expression.text === DEFAULT_RUNTIME_MODULE || expression.text === LEGACY_RUNTIME_MODULE);
}

function resolveRuntimeModule(
  runtimeModule: ContractTransformerOptions['runtimeModule'],
  sourceFile: ts.SourceFile,
): string {
  if (typeof runtimeModule === 'function') {
    return runtimeModule(sourceFile);
  }
  return runtimeModule ?? DEFAULT_RUNTIME_MODULE;
}

function updateFunctionLike(
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  node: ts.FunctionLikeDeclaration & { readonly body: ts.ConciseBody },
  parameters: readonly ts.ParameterDeclaration[],
  body: ts.ConciseBody,
): ts.FunctionLikeDeclaration {
  if (typescript.isFunctionDeclaration(node)) {
    return factory.updateFunctionDeclaration(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      parameters,
      node.type,
      body as ts.Block,
    );
  }
  if (typescript.isFunctionExpression(node)) {
    return factory.updateFunctionExpression(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      parameters,
      node.type,
      body as ts.Block,
    );
  }
  if (typescript.isArrowFunction(node)) {
    return factory.updateArrowFunction(
      node,
      node.modifiers,
      node.typeParameters,
      parameters,
      node.type,
      node.equalsGreaterThanToken,
      body,
    );
  }
  if (typescript.isMethodDeclaration(node)) {
    return factory.updateMethodDeclaration(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.questionToken,
      node.typeParameters,
      parameters,
      node.type,
      body as ts.Block,
    );
  }
  if (typescript.isGetAccessorDeclaration(node)) {
    return factory.updateGetAccessorDeclaration(
      node,
      node.modifiers,
      node.name,
      parameters,
      node.type,
      body as ts.Block,
    );
  }
  if (typescript.isSetAccessorDeclaration(node)) {
    return factory.updateSetAccessorDeclaration(
      node,
      node.modifiers,
      node.name,
      parameters,
      body as ts.Block,
    );
  }
  if (typescript.isConstructorDeclaration(node)) {
    return factory.updateConstructorDeclaration(node, node.modifiers, parameters, body as ts.Block);
  }
  return node;
}

function isFunctionLikeWithBody(
  typescript: typeof import('typescript'),
  node: ts.Node,
): node is ts.FunctionLikeDeclaration & { readonly body: ts.ConciseBody } {
  return (
    typescript.isFunctionDeclaration(node) ||
    typescript.isFunctionExpression(node) ||
    typescript.isArrowFunction(node) ||
    typescript.isMethodDeclaration(node) ||
    typescript.isGetAccessorDeclaration(node) ||
    typescript.isSetAccessorDeclaration(node) ||
    typescript.isConstructorDeclaration(node)
  ) && node.body !== undefined;
}

function isDirectSuperCall(
  typescript: typeof import('typescript'),
  statement: ts.Statement,
): boolean {
  return typescript.isExpressionStatement(statement) &&
    typescript.isCallExpression(statement.expression) &&
    statement.expression.expression.kind === typescript.SyntaxKind.SuperKeyword;
}

function isThisParameter(
  typescript: typeof import('typescript'),
  parameter: ts.ParameterDeclaration,
): boolean {
  return typescript.isIdentifier(parameter.name) && parameter.name.text === 'this';
}

function getFunctionName(
  typescript: typeof import('typescript'),
  node: ts.FunctionLikeDeclaration,
): string {
  if ('name' in node && node.name !== undefined) {
    if (typescript.isIdentifier(node.name) || typescript.isStringLiteral(node.name) || typescript.isNumericLiteral(node.name)) {
      return node.name.text;
    }
  }
  return '<anonymous>';
}

function hasModifier(
  typescript: typeof import('typescript'),
  node: ts.Node,
  kind: ts.SyntaxKind,
): boolean {
  return typescript.canHaveModifiers(node) && typescript.getModifiers(node)?.some(
    (modifier) => modifier.kind === kind,
  ) === true;
}

function findLastImportIndex(
  typescript: typeof import('typescript'),
  statements: readonly ts.Statement[],
): number {
  let lastImportIndex = -1;
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (typescript.isImportDeclaration(statement) || typescript.isImportEqualsDeclaration(statement)) {
      lastImportIndex = index;
    }
  }
  return lastImportIndex;
}

function isExpression(node: ts.Node | undefined): node is ts.Expression {
  return node !== undefined;
}

function isConciseBody(node: ts.Node | undefined): node is ts.ConciseBody {
  return node !== undefined;
}
