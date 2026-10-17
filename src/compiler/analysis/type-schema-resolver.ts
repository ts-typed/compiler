import type ts from 'typescript';

import type { ObjectPropertySchema, Schema } from '../../runtime';
import type { SchemaResolution } from './schema-resolution.interface';

const ALIAS_LIMIT_REASON =
  'The value is validated at the typed boundary, but mutations through external aliases can escape.';

interface CompoundResolution {
  readonly schema?: Schema;
  readonly status: 'protected' | 'partial' | 'unsupported';
  readonly reason?: string;
}

export class TypeSchemaResolver {
  private readonly _definitions = new Map<string, Schema>();
  private readonly _definitionNames = new Map<ts.Type, string>();
  private readonly _definitionResolutions = new Map<ts.Type, SchemaResolution>();
  private readonly _definitionTypes = new Map<string, ts.Type>();
  private readonly _resolvingDefinitions = new Set<ts.Type>();
  private readonly _classSymbolsByDefinitionName = new Map<string, ts.Symbol>();

  public constructor(
    private readonly _typescript: typeof import('typescript'),
    private readonly _checker: ts.TypeChecker,
  ) {}

  public resolve(type: ts.Type, node: ts.Node): SchemaResolution {
    return this._resolveType(type, node, true);
  }

  public getDefinitions(): Readonly<Record<string, Schema>> {
    return Object.freeze(Object.fromEntries(this._definitions));
  }

  /**
   * The class declaration symbol backing a named object definition, when
   * that definition's type originated from a class rather than an
   * interface/type alias. Used by the transformer to decide whether it can
   * embed a live `instanceof` reference for `compiler.strictClass`.
   */
  public getClassSymbol(definitionName: string): ts.Symbol | undefined {
    return this._classSymbolsByDefinitionName.get(definitionName);
  }

  private _resolveType(type: ts.Type, node: ts.Node, canCreateDefinition: boolean): SchemaResolution {
    const directResolution = this._resolveDirectType(type);
    if (directResolution !== undefined) {
      return directResolution;
    }

    if (type.isUnion()) {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveComposite(type.types, node, 'union'),
      );
    }
    if (type.isIntersection()) {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveComposite(type.types, node, 'intersection'),
      );
    }
    if ((type.flags & this._typescript.TypeFlags.TypeParameter) !== 0) {
      return this._unsupported(
        `Generic type parameter ${this._checker.typeToString(type, node)} has no concrete runtime contract.`,
      );
    }
    if (this._checker.isTupleType(type)) {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveTuple(type, node),
      );
    }
    if (this._checker.isArrayType(type)) {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveArray(type, node),
      );
    }
    if ((type.flags & this._typescript.TypeFlags.Object) !== 0) {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveObject(type, node),
      );
    }

    return this._unsupported(
      `Type ${this._checker.typeToString(type, node)} cannot be represented by the runtime schema model.`,
    );
  }

  private _resolveDirectType(type: ts.Type): SchemaResolution | undefined {
    const flags = type.flags;
    const typeFlags = this._typescript.TypeFlags;

    if ((flags & typeFlags.Any) !== 0) {
      return { status: 'open', schema: { kind: 'unknown' }, reason: 'The effective contract is any.' };
    }
    if ((flags & typeFlags.Unknown) !== 0) {
      return {
        status: 'open',
        schema: { kind: 'unknown' },
        reason: 'The effective contract is unknown.',
      };
    }
    if ((flags & typeFlags.Never) !== 0) {
      return { status: 'protected', schema: { kind: 'never' } };
    }
    if (type.isStringLiteral()) {
      return { status: 'protected', schema: { kind: 'literal', value: type.value } };
    }
    if (type.isNumberLiteral()) {
      return { status: 'protected', schema: { kind: 'literal', value: type.value } };
    }
    if ((flags & typeFlags.BooleanLiteral) !== 0) {
      const booleanValue = this._checker.typeToString(type) === 'true';
      return { status: 'protected', schema: { kind: 'literal', value: booleanValue } };
    }
    if ((flags & typeFlags.BigIntLiteral) !== 0) {
      const valueText = this._checker.typeToString(type).replace(/n$/, '');
      return { status: 'protected', schema: { kind: 'literal', value: BigInt(valueText) } };
    }
    if ((flags & typeFlags.UniqueESSymbol) !== 0) {
      return this._unsupported('Unique symbol identity cannot be represented by the runtime schema model.');
    }
    if ((flags & typeFlags.String) !== 0) {
      return { status: 'protected', schema: { kind: 'primitive', name: 'string' } };
    }
    if ((flags & typeFlags.Number) !== 0) {
      return { status: 'protected', schema: { kind: 'primitive', name: 'number' } };
    }
    if ((flags & typeFlags.Boolean) !== 0) {
      return { status: 'protected', schema: { kind: 'primitive', name: 'boolean' } };
    }
    if ((flags & typeFlags.BigInt) !== 0) {
      return { status: 'protected', schema: { kind: 'primitive', name: 'bigint' } };
    }
    if ((flags & typeFlags.ESSymbol) !== 0) {
      return { status: 'protected', schema: { kind: 'primitive', name: 'symbol' } };
    }
    if ((flags & typeFlags.Null) !== 0) {
      return { status: 'protected', schema: { kind: 'literal', value: null } };
    }
    if ((flags & (typeFlags.Undefined | typeFlags.Void)) !== 0) {
      return { status: 'protected', schema: { kind: 'literal', value: undefined } };
    }
    if ((flags & typeFlags.NonPrimitive) !== 0) {
      return { status: 'protected', schema: { kind: 'primitive', name: 'object' } };
    }

    return undefined;
  }

  private _resolveDefinitionOrCompound(
    type: ts.Type,
    node: ts.Node,
    canCreateDefinition: boolean,
    resolveCompound: () => CompoundResolution,
  ): SchemaResolution {
    const definitionName = canCreateDefinition ? this._getDefinitionName(type, node) : undefined;
    if (definitionName === undefined) {
      return resolveCompound();
    }
    if (this._resolvingDefinitions.has(type)) {
      return { status: 'partial', schema: { kind: 'ref', name: definitionName }, reason: ALIAS_LIMIT_REASON };
    }
    const cachedResolution = this._definitionResolutions.get(type);
    if (cachedResolution !== undefined) {
      return {
        status: cachedResolution.status,
        schema: { kind: 'ref', name: definitionName },
        ...(cachedResolution.reason === undefined ? {} : { reason: cachedResolution.reason }),
      };
    }

    this._resolvingDefinitions.add(type);
    const resolvedDefinition = resolveCompound();
    this._resolvingDefinitions.delete(type);
    if (resolvedDefinition.schema === undefined || resolvedDefinition.status === 'unsupported') {
      this._definitionNames.delete(type);
      this._definitionTypes.delete(definitionName);
      return resolvedDefinition;
    }

    const resolution: SchemaResolution = {
      status: resolvedDefinition.status,
      schema: { kind: 'ref', name: definitionName },
      ...(resolvedDefinition.reason === undefined ? {} : { reason: resolvedDefinition.reason }),
    };
    this._definitions.set(definitionName, resolvedDefinition.schema);
    const classSymbol = this._getClassSymbol(type);
    if (classSymbol !== undefined) {
      this._classSymbolsByDefinitionName.set(definitionName, classSymbol);
    }
    this._definitionResolutions.set(type, resolution);
    return resolution;
  }

  private _resolveComposite(
    members: readonly ts.Type[],
    node: ts.Node,
    kind: 'union' | 'intersection',
  ): CompoundResolution {
    const resolutions = members.map((member) => this._resolveType(member, node, true));
    const unsupported = resolutions.find((resolution) => resolution.schema === undefined);
    if (unsupported !== undefined) {
      return this._unsupported(
        `${kind === 'union' ? 'Union' : 'Intersection'} member is unsupported: ${unsupported.reason ?? 'unknown type limit'}`,
      );
    }
    const resolvedSchemas = resolutions.flatMap((resolution) =>
      resolution.schema === undefined ? [] : [resolution.schema],
    );
    const schemas =
      kind === 'intersection'
        ? resolvedSchemas.map((schema) => this._expandIntersectionObjectReference(schema))
        : resolvedSchemas;
    const isPartial = resolutions.some((resolution) => resolution.status === 'partial');
    return {
      status: isPartial ? 'partial' : 'protected',
      schema: { kind, schemas },
      ...(isPartial ? { reason: ALIAS_LIMIT_REASON } : {}),
    };
  }

  private _expandIntersectionObjectReference(schema: Schema): Schema {
    if (schema.kind !== 'ref') {
      return schema;
    }
    const definition = this._definitions.get(schema.name);
    return definition?.kind === 'object' ? definition : schema;
  }

  private _resolveTuple(type: ts.Type, node: ts.Node): CompoundResolution {
    const tupleReference = type as ts.TupleTypeReference;
    const elementFlags = tupleReference.target.elementFlags;
    if (elementFlags.some((flag) => (flag & this._typescript.ElementFlags.Optional) !== 0)) {
      return this._unsupported('Optional tuple positions are not represented by the runtime schema model.');
    }

    const typeArguments = this._checker.getTypeArguments(tupleReference);
    const restIndex = elementFlags.findIndex(
      (flag) => (flag & (this._typescript.ElementFlags.Rest | this._typescript.ElementFlags.Variadic)) !== 0,
    );
    const fixedTypes = restIndex === -1 ? typeArguments : typeArguments.slice(0, restIndex);
    const fixedResolutions = fixedTypes.map((itemType) => this._resolveType(itemType, node, true));
    const restResolution =
      restIndex === -1 ? undefined : this._resolveType(typeArguments[restIndex], node, true);
    const unsupported = [...fixedResolutions, ...(restResolution === undefined ? [] : [restResolution])].find(
      (resolution) => resolution.schema === undefined,
    );
    if (unsupported !== undefined) {
      return this._unsupported(`Tuple item is unsupported: ${unsupported.reason ?? 'unknown type limit'}`);
    }

    const items = fixedResolutions.flatMap((resolution) =>
      resolution.schema === undefined ? [] : [resolution.schema],
    );
    return {
      status: 'partial',
      schema: {
        kind: 'tuple',
        items,
        ...(restResolution?.schema === undefined ? {} : { rest: restResolution.schema }),
      },
      reason: ALIAS_LIMIT_REASON,
    };
  }

  private _resolveArray(type: ts.Type, node: ts.Node): CompoundResolution {
    const typeReference = type as ts.TypeReference;
    const itemType = this._checker.getTypeArguments(typeReference)[0];
    if (itemType === undefined) {
      return this._unsupported('Array element type could not be determined.');
    }
    const itemResolution = this._resolveType(itemType, node, true);
    if (itemResolution.schema === undefined) {
      return this._unsupported(
        `Array element is unsupported: ${itemResolution.reason ?? 'unknown type limit'}`,
      );
    }
    return {
      status: 'partial',
      schema: { kind: 'array', items: itemResolution.schema },
      reason: ALIAS_LIMIT_REASON,
    };
  }

  private _resolveObject(type: ts.Type, node: ts.Node): CompoundResolution {
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      return this._unsupported('Callable and constructable contracts are not represented by object schemas.');
    }

    // A class reference is validated the same as any other structural object
    // schema: old-style `private`/`protected` members have no runtime effect
    // (erased by TypeScript) and are reflectively indistinguishable from
    // public fields. Only a true ECMAScript `#private` field is genuinely
    // opaque to the runtime: it has no property key reachable through
    // Reflect, so it cannot be represented or validated structurally.
    const propertyEntries: Array<readonly [string, ObjectPropertySchema]> = [];
    for (const property of this._checker.getPropertiesOfType(type)) {
      const propertyName = property.getName();
      if (propertyName.startsWith('__@')) {
        return this._unsupported('Symbol-named properties cannot be represented with stable runtime identity.');
      }
      if (propertyName.startsWith('#')) {
        return this._unsupported(
          'True #private class fields have no reflective runtime access and cannot be represented by the runtime schema model.',
        );
      }
      const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? node;
      const propertyType = this._checker.getTypeOfSymbolAtLocation(property, declaration);
      const propertyResolution = this._resolveType(propertyType, declaration, true);
      if (propertyResolution.schema === undefined) {
        return this._unsupported(
          `Property ${propertyName} is unsupported: ${propertyResolution.reason ?? 'unknown type limit'}`,
        );
      }
      propertyEntries.push([
        propertyName,
        {
          schema: propertyResolution.schema,
          ...((property.flags & this._typescript.SymbolFlags.Optional) === 0
            ? {}
            : { optional: true }),
          ...(this._hasDefiniteAssignmentAssertion(property)
            ? { optional: true, deferredAssignment: true }
            : {}),
        },
      ]);
    }

    const indexInfos = this._checker.getIndexInfosOfType(type);
    if (indexInfos.length > 1) {
      return this._unsupported(
        'Multiple index signatures cannot be represented because the runtime schema has one index contract.',
      );
    }
    const indexResolution =
      indexInfos.length === 0 ? undefined : this._resolveType(indexInfos[0].type, node, true);
    if (indexResolution !== undefined && indexResolution.schema === undefined) {
      return this._unsupported(
        `Index signature is unsupported: ${indexResolution.reason ?? 'unknown type limit'}`,
      );
    }

    const hasIndex = indexResolution?.schema !== undefined;
    return {
      status: 'partial',
      schema: {
        kind: 'object',
        properties: Object.fromEntries(propertyEntries),
        ...(hasIndex ? { index: indexResolution.schema } : {}),
      },
      reason: hasIndex
        ? `${ALIAS_LIMIT_REASON} The single runtime index contract does not distinguish string and symbol keys.`
        : ALIAS_LIMIT_REASON,
    };
  }

  private _getDefinitionName(type: ts.Type, node: ts.Node): string | undefined {
    const existingName = this._definitionNames.get(type);
    if (existingName !== undefined) {
      return existingName;
    }
    const symbol = type.aliasSymbol ?? type.getSymbol();
    if (symbol === undefined || symbol.getName().startsWith('__')) {
      return undefined;
    }
    const declarations = symbol.getDeclarations();
    if (declarations === undefined || declarations.length === 0) {
      return undefined;
    }
    const candidate = this._checker.typeToString(
      type,
      node,
      this._typescript.TypeFormatFlags.NoTruncation,
    );
    let definitionName = candidate;
    let collisionIndex = 2;
    while (
      this._definitionTypes.has(definitionName) &&
      this._definitionTypes.get(definitionName) !== type
    ) {
      definitionName = `${candidate}#${collisionIndex}`;
      collisionIndex += 1;
    }
    this._definitionNames.set(type, definitionName);
    this._definitionTypes.set(definitionName, type);
    return definitionName;
  }

  private _hasDefiniteAssignmentAssertion(property: ts.Symbol): boolean {
    // A class field declared with a definite assignment assertion (`field!:
    // T`, e.g. Angular-style `@Input() value!: T`) explicitly tells
    // TypeScript "this is not assigned yet here, trust me" — the compiler
    // does not verify it is set by the constructor. Treating it as required
    // in the structural schema would reject `new SomeClass()` the instant
    // it is constructed, before the caller has had a chance to assign it,
    // defeating that well-established, intentional pattern. The field stays
    // fully protected: `installFieldGuard` still validates whatever value is
    // eventually written to it.
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    return declaration !== undefined
      && this._typescript.isPropertyDeclaration(declaration)
      && declaration.exclamationToken !== undefined;
  }

  private _getClassSymbol(type: ts.Type): ts.Symbol | undefined {
    const symbol = type.getSymbol();
    const hasClassDeclaration = symbol
      ?.getDeclarations()
      ?.some((declaration) => this._typescript.isClassDeclaration(declaration)) === true;
    return hasClassDeclaration ? symbol : undefined;
  }

  private _unsupported(reason: string): SchemaResolution & { readonly status: 'unsupported' } {
    return { status: 'unsupported', reason };
  }
}
