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
  /** Contract for the values produced by `yield` (generators only; distinct from the return `schema`). */
  readonly yieldSchema?: Schema;
  readonly isAsync: boolean;
  readonly name: string;
}

interface FieldGuard {
  readonly descriptor: ContractDescriptor;
  readonly key: ts.Expression;
  readonly initialized: boolean;
  readonly schema: Schema;
  readonly readonlyField: boolean;
  readonly requiredField: boolean;
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
        if (
          (typescript.isPrefixUnaryExpression(node) || typescript.isPostfixUnaryExpression(node)) &&
          (node.operator === typescript.SyntaxKind.PlusPlusToken ||
            node.operator === typescript.SyntaxKind.MinusMinusToken)
        ) {
          return visitUpdateExpression(node, factory, typescript, visitor);
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
        if (typescript.isYieldExpression(node)) {
          return visitYieldExpression(node, state, factory, typescript, visitor, context);
        }
        if (isFunctionLikeWithBody(typescript, node)) {
          return visitFunctionLike(node, state, factory, typescript, checker, visitor, context);
        }
        return typescript.visitEachChild(node, visitor, context);
      };

      const visited = typescript.visitEachChild(sourceFile, visitor, context);
      reportUnhandledContracts(options, state);
      return addRuntimePrelude(visited, state, factory, typescript, options, context);
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

/**
 * Returns the expression that actually receives an assignment or update
 * operator, by peeling off any parentheses and type-only wrappers (`as`,
 * `<T>`, `!`, `satisfies`) that sit directly around it. Stops as soon as the
 * result is not one of those wrappers, so member and element accesses keep
 * their own object expressions visited normally.
 */
function unwrapAssignmentTarget(
  typescript: typeof import('typescript'),
  expression: ts.Expression,
): ts.Expression {
  let current = expression;
  while (
    typescript.isParenthesizedExpression(current) ||
    typescript.isAsExpression(current) ||
    typescript.isTypeAssertionExpression(current) ||
    typescript.isNonNullExpression(current) ||
    typescript.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isAssignmentOperator(
  typescript: typeof import('typescript'),
  kind: ts.SyntaxKind,
): boolean {
  switch (kind) {
    case typescript.SyntaxKind.EqualsToken:
    case typescript.SyntaxKind.PlusEqualsToken:
    case typescript.SyntaxKind.MinusEqualsToken:
    case typescript.SyntaxKind.AsteriskEqualsToken:
    case typescript.SyntaxKind.AsteriskAsteriskEqualsToken:
    case typescript.SyntaxKind.SlashEqualsToken:
    case typescript.SyntaxKind.PercentEqualsToken:
    case typescript.SyntaxKind.LessThanLessThanEqualsToken:
    case typescript.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case typescript.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
    case typescript.SyntaxKind.AmpersandEqualsToken:
    case typescript.SyntaxKind.BarEqualsToken:
    case typescript.SyntaxKind.CaretEqualsToken:
    case typescript.SyntaxKind.AmpersandAmpersandEqualsToken:
    case typescript.SyntaxKind.BarBarEqualsToken:
    case typescript.SyntaxKind.QuestionQuestionEqualsToken:
      return true;
    default:
      return false;
  }
}

/**
 * Maps an arithmetic or bitwise compound assignment operator (`+=`, `<<=`, …)
 * to its binary operator (`+`, `<<`, …). Returns `undefined` for the logical
 * assignment operators (`&&=`, `||=`, `??=`): those short-circuit, so
 * rewriting `x &&= y` as `x = x && y` would change whether `y` is evaluated.
 */
function getCompoundAssignmentBinaryOperator(
  typescript: typeof import('typescript'),
  kind: ts.SyntaxKind,
): ts.BinaryOperator | undefined {
  switch (kind) {
    case typescript.SyntaxKind.PlusEqualsToken:
      return typescript.SyntaxKind.PlusToken;
    case typescript.SyntaxKind.MinusEqualsToken:
      return typescript.SyntaxKind.MinusToken;
    case typescript.SyntaxKind.AsteriskEqualsToken:
      return typescript.SyntaxKind.AsteriskToken;
    case typescript.SyntaxKind.AsteriskAsteriskEqualsToken:
      return typescript.SyntaxKind.AsteriskAsteriskToken;
    case typescript.SyntaxKind.SlashEqualsToken:
      return typescript.SyntaxKind.SlashToken;
    case typescript.SyntaxKind.PercentEqualsToken:
      return typescript.SyntaxKind.PercentToken;
    case typescript.SyntaxKind.LessThanLessThanEqualsToken:
      return typescript.SyntaxKind.LessThanLessThanToken;
    case typescript.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      return typescript.SyntaxKind.GreaterThanGreaterThanToken;
    case typescript.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      return typescript.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
    case typescript.SyntaxKind.AmpersandEqualsToken:
      return typescript.SyntaxKind.AmpersandToken;
    case typescript.SyntaxKind.BarEqualsToken:
      return typescript.SyntaxKind.BarToken;
    case typescript.SyntaxKind.CaretEqualsToken:
      return typescript.SyntaxKind.CaretToken;
    default:
      return undefined;
  }
}

function visitUpdateExpression(
  node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
): ts.PrefixUnaryExpression | ts.PostfixUnaryExpression {
  const target = unwrapAssignmentTarget(typescript, node.operand);
  const operand = typescript.visitNode(target, visitor, isExpression) ?? target;
  return typescript.isPrefixUnaryExpression(node)
    ? factory.updatePrefixUnaryExpression(node, operand)
    : factory.updatePostfixUnaryExpression(node, operand);
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
  const isAssignment = isAssignmentOperator(typescript, node.operatorToken.kind);
  const target = isAssignment ? unwrapAssignmentTarget(typescript, node.left) : node.left;
  const left = typescript.visitNode(target, visitor, isExpression) ?? target;
  const right = typescript.visitNode(node.right, visitor, isExpression) ?? node.right;
  if (!typescript.isIdentifier(target)) {
    return factory.updateBinaryExpression(node, left, node.operatorToken, right);
  }

  const symbol = checker.getSymbolAtLocation(target);
  const descriptor = symbol === undefined ? undefined : variableContracts.get(symbol);
  if (descriptor === undefined || descriptor.resolution.schema === undefined) {
    return factory.updateBinaryExpression(node, left, node.operatorToken, right);
  }
  if (!isAssignment) {
    // Comparisons (`>=`, `===`, `&&`, …) merely read the identifier; there is
    // nothing being written here, so this is not a compound-assignment case
    // and must not be reported as one.
    return factory.updateBinaryExpression(node, left, node.operatorToken, right);
  }
  if (node.operatorToken.kind !== typescript.SyntaxKind.EqualsToken) {
    // `n += x` on a plain identifier is exactly `n = n + x`: the identifier has
    // no side effects on read, so it is evaluated once either way. Rewrite it
    // so the result is checked against the variable's schema.
    const binaryOperator = getCompoundAssignmentBinaryOperator(typescript, node.operatorToken.kind);
    if (binaryOperator !== undefined) {
      state.handledContracts.add(descriptor);
      return factory.updateBinaryExpression(
        node,
        left,
        factory.createToken(typescript.SyntaxKind.EqualsToken),
        createProtectCall(
          factory,
          state,
          descriptor.resolution.schema,
          factory.createBinaryExpression(left, binaryOperator, right),
          descriptor,
          'set',
        ),
      );
    }

    // Logical assignments (`&&=`, `||=`, `??=`) short-circuit and stay unsupported.
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

function visitYieldExpression(
  node: ts.YieldExpression,
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.YieldExpression {
  const expression = node.expression === undefined
    ? undefined
    : typescript.visitNode(node.expression, visitor, isExpression) as ts.Expression | undefined;
  const functionState = state.functionStack.at(-1);
  // `yield* delegate` is out of scope (it delegates to a whole iterable), and a bare `yield;`
  // carries no value to check.
  if (
    node.asteriskToken !== undefined ||
    expression === undefined ||
    functionState?.yieldSchema === undefined
  ) {
    return factory.updateYieldExpression(node, node.asteriskToken, expression);
  }

  const value = functionState.isAsync
    ? factory.createAwaitExpression(expression)
    : expression;
  return factory.updateYieldExpression(
    node,
    undefined,
    createProtectCall(
      factory,
      state,
      functionState.yieldSchema,
      value,
      { kind: 'yield', name: functionState.name },
      'yield',
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
  const yieldSchema = getYieldSchema(node, descriptor, state, checker, typescript);
  const functionState: FunctionVisitState = {
    declaration: node,
    descriptor,
    schema: returnSchema,
    yieldSchema,
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
  // Static fields belong to the class, not to an instance, so their guards are
  // installed in a `static { ... }` block (where `this` is the class) instead of
  // the constructor.
  const staticGuards: FieldGuard[] = [];
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
        hasModifier(typescript, member, typescript.SyntaxKind.StaticKeyword) ? staticGuards : guards,
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
      const transformed = (typescript.visitNode(member, visitor, isClassElement) ?? member) as ts.ConstructorDeclaration;
      implementationConstructor = transformed;
      visitedMembers.push(transformed);
      continue;
    }
    visitedMembers.push((typescript.visitNode(member, visitor, isClassElement) ?? member) as ts.ClassElement);
  }

  const staticGuardBlock = createStaticFieldGuardBlock(staticGuards, state, factory);
  if (staticGuardBlock !== undefined) {
    visitedMembers.push(staticGuardBlock);
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
  const requiredFieldLockStatements = createRequiredFieldFinalizeStatements(node, guards, state, factory, typescript);
  const lockStatements = [
    ...guards.filter((guard) => guard.readonlyField).map((guard) => createLockReadonlyFieldCall(factory, state, guard)),
    ...privateLockStatements,
    ...requiredFieldLockStatements,
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

/**
 * Builds the (possibly empty) one-statement block that finalizes required
 * fields against `delete`/`Object.defineProperty` for this class, guarded
 * by `new.target === <className>` so it only fires once construction has
 * reached the most-derived class — see {@link createNewTargetIsClassCheck}.
 * Anonymous class expressions have no name to compare `new.target` against
 * and are a rare pattern in practice (NestJS/TypeORM classes are always
 * named), so this is skipped for them: their required fields simply keep
 * the same `configurable: true` behavior as before this feature existed,
 * rather than risk comparing `new.target` against nothing meaningful.
 */
function createRequiredFieldFinalizeStatements(
  node: ts.ClassLikeDeclaration,
  guards: readonly FieldGuard[],
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
): readonly ts.Statement[] {
  const requiredGuards = guards.filter((guard) => guard.requiredField);
  if (requiredGuards.length === 0 || node.name === undefined) {
    return [];
  }
  const lockCalls = requiredGuards.map((guard) => createLockRequiredFieldCall(factory, state, guard));
  return [
    factory.createIfStatement(
      createNewTargetIsClassCheck(factory, typescript, node.name),
      factory.createBlock(lockCalls, true),
    ),
  ];
}

/**
 * Builds a `static { ... }` block that installs guards for the class's own
 * `static` fields. Inside a static block `this` is the class constructor, so
 * the same install/lock calls used for instance fields apply unchanged. The
 * required-field lock is applied unconditionally: static blocks run exactly
 * once, when the class is defined, so there is no subclass construction that
 * could need the deferred `new.target` check used for instance fields.
 */
function createStaticFieldGuardBlock(
  guards: readonly FieldGuard[],
  state: FileTransformState,
  factory: ts.NodeFactory,
): ts.ClassStaticBlockDeclaration | undefined {
  if (guards.length === 0) {
    return undefined;
  }
  const statements: ts.Statement[] = [
    ...guards.map((guard) => createInstallFieldGuard(factory, state, guard)),
    ...guards.filter((guard) => guard.readonlyField).map((guard) => createLockReadonlyFieldCall(factory, state, guard)),
    ...guards.filter((guard) => guard.requiredField).map((guard) => createLockRequiredFieldCall(factory, state, guard)),
  ];
  return factory.createClassStaticBlockDeclaration(factory.createBlock(statements, true));
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
    // Only a BARE field (no `?`, no `!`) is safe to lock as readonly right
    // after construction. TypeScript's own `strictPropertyInitialization`
    // already guarantees a bare field has a real value by the time any
    // constructor (synthesized or user-written) finishes — either an
    // inline initializer or a genuine constructor-body assignment, both of
    // which run before the lock. `?` and `!` both mean the opposite: the
    // field may legitimately still be unset (or only "promised" to be set
    // later) when construction completes, because the author is relying on
    // something OUTSIDE the constructor to assign it — the exact pattern
    // NestJS's `plainToInstance`/class-transformer relies on for a DTO
    // with no constructor: `new Dto()`, then `instance.field = value` from
    // the outside, for every field, required or optional. Locking either
    // kind at "end of construction" — which is effectively "immediately"
    // for a class with no user constructor body — would make that
    // external assignment throw READONLY_PROPERTY before it ever runs.
    readonlyField: enforceReadonly
      && hasModifier(typescript, node, typescript.SyntaxKind.ReadonlyKeyword)
      && node.questionToken === undefined
      && node.exclamationToken === undefined,
    // Only a bare field (no `?` and no `!`) is required: `!` is a definite
    // assignment assertion and the field is tolerated as absent until assigned.
    requiredField: node.questionToken === undefined && node.exclamationToken === undefined,
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

function createLockRequiredFieldCall(
  factory: ts.NodeFactory,
  state: FileTransformState,
  guard: FieldGuard,
): ts.Statement {
  return factory.createExpressionStatement(
    factory.createCallExpression(
      factory.createPropertyAccessExpression(state.runtimeIdentifier, 'lockRequiredField'),
      undefined,
      [factory.createThis(), guard.key],
    ),
  );
}

/**
 * `new.target === <className>` — true only when THIS class is the one
 * actually being constructed (`new ClassName()`), never when a subclass's
 * `super()` call is running this class's own constructor code. Used to
 * defer a one-time, irreversible finalization step (like
 * {@link createLockRequiredFieldCall}'s non-configurable lock) until
 * construction has reached the most-derived class, so a subclass that
 * redeclares the same field still gets to (re)initialize it first.
 */
function createNewTargetIsClassCheck(
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
  className: ts.Identifier,
): ts.Expression {
  return factory.createBinaryExpression(
    factory.createMetaProperty(typescript.SyntaxKind.NewKeyword, factory.createIdentifier('target')),
    factory.createToken(typescript.SyntaxKind.EqualsEqualsEqualsToken),
    className,
  );
}

function createProtectCall(
  factory: ts.NodeFactory,
  state: FileTransformState,
  schema: Schema,
  value: ts.Expression,
  descriptor: ProtectedContractLabel,
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

/** The only descriptor fields the runtime context needs; `yield` checks have no ContractDescriptor. */
interface ProtectedContractLabel {
  readonly kind: string;
  readonly name: string;
}

function createContextExpression(
  factory: ts.NodeFactory,
  state: FileTransformState,
  descriptor: ProtectedContractLabel,
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
  context: ts.TransformationContext,
): ts.SourceFile {
  const runtimeImport = isEsModuleOutput(sourceFile, context.getCompilerOptions(), typescript)
    ? createRuntimeImportDeclaration(state, factory)
    : createRuntimeRequireStatement(state, factory, typescript);
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

/**
 * Whether TypeScript will emit this file with native ES module syntax, in
 * which case the runtime must be brought in with an `import` declaration.
 *
 * - Non-node module kinds (`ESNext`, `ES2015`, `ES2020`, `ES2022`) emit ESM
 *   for every file; CommonJS, UMD, AMD and System emit `require`-style code.
 * - `Node16`/`NodeNext` decide per file from `impliedNodeFormat` (set from
 *   the nearest `package.json` `type` field or the `.mts`/`.cts` extension).
 *   This is the same granularity tsc uses to emit the file, so it is exact.
 * - `Preserve` leaves `import`/`export` syntax untouched, so the file is
 *   ESM unless TypeScript recorded it as a CommonJS-format file.
 */
function isEsModuleOutput(
  sourceFile: ts.SourceFile,
  compilerOptions: ts.CompilerOptions,
  typescript: typeof import('typescript'),
): boolean {
  const moduleKind = resolveEmitModuleKind(compilerOptions, typescript);
  const { ModuleKind } = typescript;
  if (moduleKind === ModuleKind.Node16 || moduleKind === ModuleKind.NodeNext) {
    return sourceFile.impliedNodeFormat === ModuleKind.ESNext;
  }
  if (moduleKind === ModuleKind.Preserve) {
    return sourceFile.impliedNodeFormat !== ModuleKind.CommonJS;
  }
  return (
    moduleKind === ModuleKind.ES2015 ||
    moduleKind === ModuleKind.ES2020 ||
    moduleKind === ModuleKind.ES2022 ||
    moduleKind === ModuleKind.ESNext
  );
}

/**
 * Resolves the module kind TypeScript uses for emit, including its default
 * when `module` is omitted (ES2015 for targets >= ES2015, CommonJS otherwise).
 * `getEmitModuleKind` is what tsc itself calls and is exported at runtime,
 * but it is absent from the public typings, hence the narrow cast and the
 * documented fallback that mirrors its logic.
 */
function resolveEmitModuleKind(
  compilerOptions: ts.CompilerOptions,
  typescript: typeof import('typescript'),
): ts.ModuleKind {
  const internal = (typescript as { getEmitModuleKind?: (options: ts.CompilerOptions) => ts.ModuleKind })
    .getEmitModuleKind;
  if (typeof internal === 'function') {
    return internal(compilerOptions);
  }
  if (compilerOptions.module !== undefined) {
    return compilerOptions.module;
  }
  const target = compilerOptions.target ?? typescript.ScriptTarget.ES5;
  return target >= typescript.ScriptTarget.ES2015
    ? typescript.ModuleKind.ES2015
    : typescript.ModuleKind.CommonJS;
}

function createRuntimeRequireStatement(
  state: FileTransformState,
  factory: ts.NodeFactory,
  typescript: typeof import('typescript'),
): ts.Statement {
  // A plain `require()` call is used for CommonJS output instead of an
  // `import` declaration because TypeScript only down-levels import/export
  // syntax to CommonJS for source files it already recognized as modules at
  // parse time. A file with no user-authored import/export (a "script") never
  // gets that down-level pass, so an injected `ImportDeclaration` would be
  // emitted verbatim as invalid ESM syntax inside a CommonJS "use strict" file.
  return factory.createVariableStatement(
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
}

function createRuntimeImportDeclaration(
  state: FileTransformState,
  factory: ts.NodeFactory,
): ts.Statement {
  // Native ESM output has no `require` global, so the runtime is bound with a
  // real namespace import. Its named exports match what `require` returned.
  return factory.createImportDeclaration(
    undefined,
    factory.createImportClause(
      false,
      undefined,
      factory.createNamespaceImport(state.runtimeIdentifier),
    ),
    factory.createStringLiteral(state.runtimeModule),
    undefined,
  );
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

function isGeneratorFunction(
  node: ts.FunctionLikeDeclaration,
  typescript: typeof import('typescript'),
): boolean {
  if (
    typescript.isFunctionDeclaration(node) ||
    typescript.isFunctionExpression(node) ||
    typescript.isMethodDeclaration(node)
  ) {
    return node.asteriskToken !== undefined;
  }
  return false;
}

/**
 * Returns the type argument at `index` of a generic reference type such as
 * `Generator<T, TReturn, TNext>`, `AsyncGenerator<...>`, `Iterable<T>` or
 * `IterableIterator<T>`. Uses only public API: the `Reference` object flag plus
 * `checker.getTypeArguments`. Returns undefined for any other type.
 */
function getTypeArgumentAt(
  checker: ts.TypeChecker,
  typescript: typeof import('typescript'),
  type: ts.Type,
  index: number,
): ts.Type | undefined {
  if ((type.flags & typescript.TypeFlags.Object) === 0) {
    return undefined;
  }
  const objectType = type as ts.ObjectType;
  if ((objectType.objectFlags & typescript.ObjectFlags.Reference) === 0) {
    return undefined;
  }
  return checker.getTypeArguments(objectType as ts.TypeReference)[index];
}

function isUncheckableType(type: ts.Type, typescript: typeof import('typescript')): boolean {
  return (type.flags & (
    typescript.TypeFlags.Any |
    typescript.TypeFlags.Unknown |
    typescript.TypeFlags.Void
  )) !== 0;
}

function getYieldSchema(
  node: ts.FunctionLikeDeclaration,
  descriptor: ContractDescriptor | undefined,
  state: FileTransformState,
  checker: ts.TypeChecker,
  typescript: typeof import('typescript'),
): Schema | undefined {
  if (!isGeneratorFunction(node, typescript)) {
    return undefined;
  }
  const signature = checker.getSignatureFromDeclaration(node);
  if (signature === undefined) {
    return undefined;
  }
  const yieldedType = getTypeArgumentAt(
    checker,
    typescript,
    checker.getReturnTypeOfSignature(signature),
    0,
  );
  if (yieldedType === undefined || isUncheckableType(yieldedType, typescript)) {
    return undefined;
  }
  const resolution = optionsForState(state).analysis.resolver.resolve(yieldedType, node);
  if (resolution.schema === undefined) {
    if (descriptor !== undefined) {
      reportUnsupported(
        optionsForState(state),
        state,
        descriptor,
        node,
        'The yielded type has no materializable runtime contract.',
      );
    }
    return undefined;
  }
  return resolution.schema;
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
    if (isGeneratorFunction(node, typescript)) {
      // A generator's `return` value is governed by TReturn (the second type argument),
      // not by the whole Generator<...> type that the analysis descriptor carries.
      const returnedType = getTypeArgumentAt(checker, typescript, returnType, 1);
      if (returnedType === undefined || isUncheckableType(returnedType, typescript)) {
        return undefined;
      }
      const resolution = optionsForState(state).analysis.resolver.resolve(returnedType, node);
      if (resolution.schema === undefined && descriptor !== undefined) {
        reportUnsupported(
          optionsForState(state),
          state,
          descriptor,
          node,
          'The generator return type has no materializable runtime contract.',
        );
      }
      return resolution.schema;
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
  if (
    hasModifier(typescript, node, typescript.SyntaxKind.StaticKeyword) &&
    (hasModifier(typescript, node, typescript.SyntaxKind.PrivateKeyword) ||
      hasModifier(typescript, node, typescript.SyntaxKind.ProtectedKeyword))
  ) {
    return 'Static private and protected fields require class-specific instrumentation.';
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

function isClassElement(node: ts.Node | undefined): node is ts.ClassElement {
  return node !== undefined;
}
