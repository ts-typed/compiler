import { createRequire } from 'node:module';
import { dirname, normalize, resolve, sep } from 'node:path';

import typescriptFallback = require('typescript');

import type {
  AnalysisResult,
  AnalyzeProjectContext,
  PrivateBracketAccessConflict,
} from './analysis-result.interface';
import type {
  ContractDescriptor,
  ContractKind,
} from './contract-descriptor.interface';
import type {
  CoverageDiagnostic,
  CoverageDiagnosticCode,
  CoverageItem,
} from './coverage.interface';
import type { SchemaResolution } from './schema-resolution.interface';
import { TypeSchemaResolver } from './type-schema-resolver';

interface ContractCandidate {
  readonly node: import('typescript').Node;
  readonly locationNode: import('typescript').Node;
  readonly name: string;
  readonly kind: ContractKind;
  readonly type?: import('typescript').Type;
  readonly unsupportedReason?: string;
  readonly diagnosticCode?: CoverageDiagnosticCode;
}

export function analyzeProject(context: AnalyzeProjectContext): AnalysisResult {
  const projectLoadStart = performance.now();
  const tsconfigPath = resolve(context.tsconfigPath);
  const typescript = loadConsumerTypescript(tsconfigPath);
  const configFile = typescript.readConfigFile(tsconfigPath, typescript.sys.readFile);
  if (configFile.error !== undefined) {
    throw new Error(formatDiagnostic(typescript, configFile.error));
  }
  const parsedConfig = typescript.parseJsonConfigFileContent(
    configFile.config,
    typescript.sys,
    dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  );
  const program = typescript.createProgram({
    rootNames: parsedConfig.fileNames,
    options: { ...parsedConfig.options, ...context.compilerOptions },
    projectReferences: parsedConfig.projectReferences,
  });
  const checker = program.getTypeChecker();
  const projectLoadMs = performance.now() - projectLoadStart;
  const typeAnalysisStart = performance.now();
  const resolver = new TypeSchemaResolver(typescript, checker);
  const contracts = new Map<import('typescript').Node, ContractDescriptor>();
  const coverage: CoverageItem[] = [];
  const diagnostics: CoverageDiagnostic[] = [];

  const addCandidate = (candidate: ContractCandidate): void => {
    const sourceFile = candidate.node.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(candidate.locationNode.getStart(sourceFile));
    const resolution: SchemaResolution =
      candidate.unsupportedReason === undefined
        ? resolver.resolve(candidate.type ?? checker.getTypeAtLocation(candidate.node), candidate.node)
        : { status: 'unsupported', reason: candidate.unsupportedReason };
    const descriptor: ContractDescriptor = {
      node: candidate.node,
      name: candidate.name,
      kind: candidate.kind,
      resolution,
      sourceFile,
      file: sourceFile.fileName,
      line: position.line + 1,
      column: position.character + 1,
    };
    contracts.set(candidate.node, descriptor);
    coverage.push(createCoverageItem(descriptor));
    const diagnostic = createCoverageDiagnostic(
      descriptor,
      candidate.diagnosticCode,
    );
    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic);
    }
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!isAnalyzableSource(sourceFile)) {
      continue;
    }
    const visit = (node: import('typescript').Node): void => {
      const candidate = getContractCandidate(typescript, checker, node, context.enforcePrivate === true);
      if (candidate !== undefined) {
        addCandidate(candidate);
      }
      typescript.forEachChild(node, visit);
    };
    typescript.forEachChild(sourceFile, visit);
  }

  const privateBracketAccessConflicts = context.enforcePrivate === true
    ? collectPrivateBracketAccessConflicts(typescript, checker, program)
    : new Map<import('typescript').Symbol, PrivateBracketAccessConflict[]>();

  const tsDiagnostics = [
    ...parsedConfig.errors,
    ...typescript.getPreEmitDiagnostics(program),
  ];
  const typeAnalysisMs = performance.now() - typeAnalysisStart;
  return {
    typescript,
    program,
    checker,
    resolver,
    contracts,
    coverage,
    diagnostics,
    tsDiagnostics,
    internalTimingMs: { projectLoad: projectLoadMs, typeAnalysis: typeAnalysisMs },
    privateBracketAccessConflicts,
  };
}

function collectPrivateBracketAccessConflicts(
  typescript: typeof import('typescript'),
  checker: import('typescript').TypeChecker,
  program: import('typescript').Program,
): Map<import('typescript').Symbol, PrivateBracketAccessConflict[]> {
  const conflicts = new Map<import('typescript').Symbol, PrivateBracketAccessConflict[]>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isAnalyzableSource(sourceFile)) {
      continue;
    }
    const visit = (node: import('typescript').Node): void => {
      if (
        typescript.isElementAccessExpression(node) &&
        typescript.isStringLiteralLike(node.argumentExpression)
      ) {
        const objectType = checker.getTypeAtLocation(node.expression);
        const propertySymbol = checker.getPropertyOfType(objectType, node.argumentExpression.text);
        if (propertySymbol !== undefined && isPrivateProperty(typescript, propertySymbol)) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const existing = conflicts.get(propertySymbol) ?? [];
          existing.push({
            file: sourceFile.fileName,
            line: position.line + 1,
            column: position.character + 1,
          });
          conflicts.set(propertySymbol, existing);
        }
      }
      typescript.forEachChild(node, visit);
    };
    typescript.forEachChild(sourceFile, visit);
  }

  return conflicts;
}

function isPrivateProperty(
  typescript: typeof import('typescript'),
  symbol: import('typescript').Symbol,
): boolean {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration === undefined || !typescript.isPropertyDeclaration(declaration)) {
    return false;
  }
  return (typescript.getCombinedModifierFlags(declaration) & typescript.ModifierFlags.Private) !== 0;
}

function loadConsumerTypescript(tsconfigPath: string): typeof import('typescript') {
  const consumerRequire = createRequire(tsconfigPath);
  try {
    const consumerTypescript: unknown = consumerRequire('typescript');
    return validateTypescriptModule(consumerTypescript);
  } catch (error: unknown) {
    if (!isMissingTypescriptModule(error)) {
      throw error;
    }
    return validateTypescriptModule(typescriptFallback);
  }
}

function validateTypescriptModule(candidate: unknown): typeof import('typescript') {
  if (!isTypescriptModule(candidate)) {
    throw new Error('The consumer typescript module does not expose the compiler API required by ts-typed.');
  }
  const [majorText, minorText] = candidate.versionMajorMinor.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major !== 5 || minor < 9) {
    throw new Error(
      `Unsupported TypeScript ${candidate.version}; ts-typed requires TypeScript >=5.9 and <6.`,
    );
  }
  return candidate;
}

function isTypescriptModule(candidate: unknown): candidate is typeof import('typescript') {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'version' in candidate &&
    typeof candidate.version === 'string' &&
    'versionMajorMinor' in candidate &&
    typeof candidate.versionMajorMinor === 'string' &&
    'readConfigFile' in candidate &&
    typeof candidate.readConfigFile === 'function' &&
    'parseJsonConfigFileContent' in candidate &&
    typeof candidate.parseJsonConfigFileContent === 'function' &&
    'createProgram' in candidate &&
    typeof candidate.createProgram === 'function'
  );
}

function isMissingTypescriptModule(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const errorCode = 'code' in error ? error.code : undefined;
  return errorCode === 'MODULE_NOT_FOUND' && error.message.includes("'typescript'");
}

function formatDiagnostic(
  typescript: typeof import('typescript'),
  diagnostic: import('typescript').Diagnostic,
): string {
  return typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function isAnalyzableSource(sourceFile: import('typescript').SourceFile): boolean {
  if (sourceFile.isDeclarationFile) {
    return false;
  }
  const normalizedFile = normalize(sourceFile.fileName);
  return !normalizedFile.includes(`${sep}node_modules${sep}`);
}

function getContractCandidate(
  typescript: typeof import('typescript'),
  checker: import('typescript').TypeChecker,
  node: import('typescript').Node,
  enforcePrivate: boolean,
): ContractCandidate | undefined {
  if (typescript.isVariableDeclaration(node)) {
    return createNamedCandidate(typescript, checker, node, node.name, 'variable', enforcePrivate);
  }
  if (typescript.isPropertyDeclaration(node)) {
    return createNamedCandidate(typescript, checker, node, node.name, 'property', enforcePrivate);
  }
  if (typescript.isParameter(node)) {
    return createNamedCandidate(typescript, checker, node, node.name, 'parameter', enforcePrivate);
  }
  if (isReturnContractNode(typescript, node)) {
    const signature = checker.getSignatureFromDeclaration(node);
    if (signature === undefined) {
      return undefined;
    }
    const nameNode = getFunctionNameNode(typescript, node);
    const returnType = checker.getReturnTypeOfSignature(signature);
    const isVoidReturn = (returnType.flags & typescript.TypeFlags.Void) !== 0;
    return {
      node,
      locationNode: nameNode ?? node,
      name: getFunctionName(typescript, node),
      kind: 'return',
      type: returnType,
      unsupportedReason: isVoidReturn
        ? 'A void return contract can accept a value in TypeScript and cannot be asserted as undefined.'
        : undefined,
      diagnosticCode: isVoidReturn ? 'TT_UNSUPPORTED_TYPE' : undefined,
    };
  }
  if (
    typescript.isAsExpression(node) ||
    typescript.isTypeAssertionExpression(node) ||
    typescript.isSatisfiesExpression(node)
  ) {
    const type = checker.getTypeFromTypeNode(node.type);
    return {
      node,
      locationNode: node,
      name: checker.typeToString(type, node),
      kind: 'expression',
      type,
    };
  }
  return undefined;
}

function createNamedCandidate(
  typescript: typeof import('typescript'),
  checker: import('typescript').TypeChecker,
  node:
    | import('typescript').VariableDeclaration
    | import('typescript').PropertyDeclaration
    | import('typescript').ParameterDeclaration,
  name: import('typescript').BindingName | import('typescript').PropertyName,
  kind: 'variable' | 'property' | 'parameter',
  enforcePrivate: boolean,
): ContractCandidate {
  if (!typescript.isIdentifier(name) && !typescript.isStringLiteral(name) && !typescript.isNumericLiteral(name)) {
    return {
      node,
      locationNode: name,
      name: name.getText(),
      kind,
      unsupportedReason: 'Computed, private, and destructuring contract names require syntax-specific instrumentation.',
      diagnosticCode: 'TT_UNSUPPORTED_SYNTAX',
    };
  }
  const unsupportedReason = getUnsupportedMemberReason(typescript, node, enforcePrivate);
  return {
    node,
    locationNode: name,
    name: name.text,
    kind,
    type: checker.getTypeAtLocation(name),
    unsupportedReason,
    diagnosticCode: unsupportedReason === undefined ? undefined : 'TT_UNSUPPORTED_SYNTAX',
  };
}

function getUnsupportedMemberReason(
  typescript: typeof import('typescript'),
  node: import('typescript').VariableDeclaration | import('typescript').PropertyDeclaration | import('typescript').ParameterDeclaration,
  enforcePrivate: boolean,
): string | undefined {
  if (!typescript.isPropertyDeclaration(node) && !typescript.isParameter(node)) {
    return undefined;
  }
  const modifierFlags = typescript.getCombinedModifierFlags(node);
  // Scoped to plain property declarations: parameter properties
  // (`constructor(private foo: string)`) implicitly create a field too, but
  // the transformer has no conversion/guard path for that shorthand yet, so
  // they stay unconditionally unsupported regardless of enforcePrivate.
  const isOnlyPrivate = typescript.isPropertyDeclaration(node)
    && (modifierFlags & typescript.ModifierFlags.Private) !== 0
    && (modifierFlags & (typescript.ModifierFlags.Protected | typescript.ModifierFlags.Static)) === 0;
  if (
    (modifierFlags &
      (typescript.ModifierFlags.Private |
        typescript.ModifierFlags.Protected |
        typescript.ModifierFlags.Static)) !==
    0 &&
    !(enforcePrivate && isOnlyPrivate)
  ) {
    return 'Private, protected, and static members require class-specific instrumentation.';
  }
  if (typescript.canHaveDecorators(node) && (typescript.getDecorators(node)?.length ?? 0) > 0) {
    return 'Decorated members require framework-compatible instrumentation.';
  }
  return undefined;
}

function isReturnContractNode(
  typescript: typeof import('typescript'),
  node: import('typescript').Node,
): node is
  | import('typescript').FunctionDeclaration
  | import('typescript').FunctionExpression
  | import('typescript').ArrowFunction
  | import('typescript').MethodDeclaration
  | import('typescript').GetAccessorDeclaration {
  return (
    typescript.isFunctionDeclaration(node) ||
    typescript.isFunctionExpression(node) ||
    typescript.isArrowFunction(node) ||
    typescript.isMethodDeclaration(node) ||
    typescript.isGetAccessorDeclaration(node)
  );
}

function getFunctionNameNode(
  typescript: typeof import('typescript'),
  node:
    | import('typescript').FunctionDeclaration
    | import('typescript').FunctionExpression
    | import('typescript').ArrowFunction
    | import('typescript').MethodDeclaration
    | import('typescript').GetAccessorDeclaration,
): import('typescript').Node | undefined {
  if ('name' in node && node.name !== undefined) {
    return node.name;
  }
  if (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) {
    const parent = node.parent;
    if (typescript.isVariableDeclaration(parent)) {
      return parent.name;
    }
  }
  return undefined;
}

function getFunctionName(
  typescript: typeof import('typescript'),
  node:
    | import('typescript').FunctionDeclaration
    | import('typescript').FunctionExpression
    | import('typescript').ArrowFunction
    | import('typescript').MethodDeclaration
    | import('typescript').GetAccessorDeclaration,
): string {
  const nameNode = getFunctionNameNode(typescript, node);
  return nameNode?.getText() ?? '<anonymous>';
}

function createCoverageItem(descriptor: ContractDescriptor): CoverageItem {
  return {
    node: descriptor.node,
    name: descriptor.name,
    kind: descriptor.kind,
    status: descriptor.resolution.status,
    file: descriptor.file,
    line: descriptor.line,
    column: descriptor.column,
    ...(descriptor.resolution.reason === undefined ? {} : { reason: descriptor.resolution.reason }),
  };
}

function createCoverageDiagnostic(
  descriptor: ContractDescriptor,
  requestedCode?: CoverageDiagnosticCode,
): CoverageDiagnostic | undefined {
  const resolution = descriptor.resolution;
  if (resolution.status !== 'partial' && resolution.status !== 'unsupported') {
    return undefined;
  }
  const code =
    requestedCode ?? (resolution.status === 'partial' ? 'TT_PARTIAL_ALIAS' : 'TT_UNSUPPORTED_TYPE');
  const reason = resolution.reason ?? 'Runtime protection is not available for this contract.';
  return {
    code,
    category: 'warning',
    file: descriptor.file,
    line: descriptor.line,
    column: descriptor.column,
    name: descriptor.name,
    kind: descriptor.kind,
    status: resolution.status,
    message: `${reason} Contract ${descriptor.name} is ${resolution.status}.`,
  };
}
