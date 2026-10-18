import type ts from 'typescript';

import type { ObjectPropertySchema, Schema } from '../../runtime';
import type { SchemaResolution } from './schema-resolution.interface';

const ALIAS_LIMIT_REASON =
  'The value is validated at the typed boundary, but mutations through external aliases can escape.';

const MAP_NAMES: ReadonlySet<string> = new Set(['Map', 'ReadonlyMap']);
const SET_NAMES: ReadonlySet<string> = new Set(['Set', 'ReadonlySet']);

/**
 * Path heuristic for the runtime `ValueObject` declaration. See
 * `_isValueObjectBase` for why this is a path check rather than package identity.
 */
function isValueObjectRuntimePath(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, '/');
  if (normalized.endsWith('/runtime/value-object.class.ts')) {
    return true;
  }
  return normalized.endsWith('/runtime/value-object.class.d.ts') && normalized.includes('/@ts-typed/compiler/');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  private readonly _valueObjectDefinitionNames = new Set<string>();

  public constructor(
    private readonly _typescript: typeof import('typescript'),
    private readonly _checker: ts.TypeChecker,
    private readonly _enforcePrivate: boolean = false,
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

  /**
   * Whether a named object definition is backed by a class that extends the
   * `ValueObject` runtime base, directly or through any number of intermediate
   * subclasses. The transformer uses this to embed a live `valueObjectCtor`
   * reference so raw strings are auto-constructed into instances.
   */
  public isValueObjectClass(definitionName: string): boolean {
    return this._valueObjectDefinitionNames.has(definitionName);
  }

  private _resolveType(type: ts.Type, node: ts.Node, canCreateDefinition: boolean): SchemaResolution {
    const directResolution = this._resolveDirectType(type);
    if (directResolution !== undefined) {
      return directResolution;
    }
    // A pure function type is an opaque leaf (see _isPureFunction) regardless
    // of WHERE it is being resolved from. _resolvePropertyType special-cases
    // this for a property being resolved as part of its containing object's
    // structural shape, but a function-typed value can also be its own
    // top-level contract — a class field's own candidate, a variable, a
    // parameter, a return — which reaches this general path directly, not
    // through _resolvePropertyType. Handling it here, before the Union
    // branch below, also means a union member that is a pure function (e.g.
    // `(() => void) | undefined`) gets the same leaf treatment through the
    // ordinary recursive _resolveComposite call, with no separate union
    // handling needed on this path.
    if (this._isPureFunction(type)) {
      return { status: 'protected', schema: { kind: 'function' } };
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
    // Map/Set carry TypeFlags.Object like any interface, so they must be
    // detected here, before the generic structural branch below.
    const collectionKind = this._getGlobalCollectionKind(type);
    if (collectionKind === 'map') {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveMap(type, node),
      );
    }
    if (collectionKind === 'set') {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveSet(type, node),
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
    if (this._isGlobalDate(type)) {
      // Date is an opaque leaf: its methods are never enumerated (they are
      // callable and would otherwise poison the whole object contract).
      return { status: 'protected', schema: { kind: 'date' } };
    }
    if ((flags & typeFlags.TemplateLiteral) !== 0) {
      return this._resolveTemplateLiteral(type as ts.TemplateLiteralType);
    }

    return undefined;
  }

  /**
   * Open template literal types (`${number}px`, `user_${string}`) are leaves
   * validated by a regex compiled from their texts and placeholders. Finite
   * interpolations (`${'a' | 'b'}`) never reach here: TypeScript already
   * expands them into a union of string literals.
   */
  private _resolveTemplateLiteral(type: ts.TemplateLiteralType): SchemaResolution {
    const pattern = this._templateLiteralPattern(type);
    if (pattern === undefined) {
      return this._unsupported(
        `Template literal type ${this._checker.typeToString(type)} has a placeholder with no runtime pattern.`,
      );
    }
    return { status: 'protected', schema: { kind: 'templateLiteral', pattern } };
  }

  private _templateLiteralPattern(type: ts.TemplateLiteralType): string | undefined {
    const placeholderPatterns: string[] = [];
    for (const placeholder of type.types) {
      const placeholderPattern = this._placeholderPattern(placeholder);
      if (placeholderPattern === undefined) {
        return undefined;
      }
      placeholderPatterns.push(placeholderPattern);
    }

    let pattern = '^';
    type.texts.forEach((text, index) => {
      pattern += escapeRegExp(text);
      if (index < placeholderPatterns.length) {
        pattern += placeholderPatterns[index];
      }
    });
    return `${pattern}$`;
  }

  private _placeholderPattern(placeholder: ts.Type): string | undefined {
    const typeFlags = this._typescript.TypeFlags;
    if ((placeholder.flags & typeFlags.String) !== 0) {
      // Any string, including the empty one. `[\s\S]` also matches newlines.
      return '[\\s\\S]*';
    }
    if ((placeholder.flags & typeFlags.Number) !== 0) {
      // Integers and plain decimals only; exponent notation, `Infinity` and
      // `NaN` are not covered (documented limitation).
      return '-?\\d+(?:\\.\\d+)?';
    }
    if ((placeholder.flags & typeFlags.BigInt) !== 0) {
      return '-?\\d+';
    }
    if ((placeholder.flags & typeFlags.Boolean) !== 0) {
      return '(?:true|false)';
    }
    if (placeholder.isStringLiteral() || placeholder.isNumberLiteral()) {
      return escapeRegExp(String(placeholder.value));
    }
    if (placeholder.isUnion()) {
      const alternatives = placeholder.types.map((member) => this._placeholderPattern(member));
      if (alternatives.some((alternative) => alternative === undefined)) {
        return undefined;
      }
      return `(?:${alternatives.join('|')})`;
    }
    return undefined;
  }

  /**
   * Heuristic: the built-in `Date` interface is declared in a TypeScript lib
   * file, which carries `/// <reference no-default-lib="true"/>` and therefore
   * `hasNoDefaultLib === true`. A user-declared class/interface named `Date`
   * lives in an ordinary module and is not matched.
   */
  /**
   * Resolves the type of an object property. A property whose type is purely a
   * function (or such a function optionally widened with `undefined`/`null`, as
   * in `onClick?: () => void`) is an opaque `function` leaf, so one callback field
   * does not make the whole containing object unsupported. Any other shape goes
   * through the general resolution unchanged.
   */
  private _resolvePropertyType(type: ts.Type, declaration: ts.Node): SchemaResolution {
    const members = type.isUnion() ? type.types : [type];
    const functionMembers = members.filter((member) => this._isPureFunction(member));
    if (functionMembers.length === 0) {
      return this._resolveType(type, declaration, true);
    }
    const typeFlags = this._typescript.TypeFlags;
    const schemas: Schema[] = [];
    for (const member of members) {
      if (this._isPureFunction(member)) {
        schemas.push({ kind: 'function' });
      } else if ((member.flags & typeFlags.Undefined) !== 0) {
        schemas.push({ kind: 'literal', value: undefined });
      } else if ((member.flags & typeFlags.Null) !== 0) {
        schemas.push({ kind: 'literal', value: null });
      } else {
        // Mixed with a non-function member: not a pure function leaf.
        return this._resolveType(type, declaration, true);
      }
    }
    return {
      status: 'protected',
      schema: schemas.length === 1 ? schemas[0] : { kind: 'union', schemas },
    };
  }

  private _isClassMethod(property: ts.Symbol): boolean {
    return (property.declarations ?? []).some(
      (declaration) =>
        this._typescript.isMethodDeclaration(declaration) && this._typescript.isClassLike(declaration.parent),
    );
  }

  /**
   * Heuristic: a type is "purely a function" when it has call signatures, no
   * construct signatures, and no own members at all. `getPropertiesOfType` does
   * not include the members inherited from the global `Function` interface
   * (`call`, `apply`, `bind`, `name`, ...), which are reached through the apparent
   * type, so an empty property list means no user-declared extras. Index
   * signatures are checked too, since they are also extra structure. Anything
   * with extra members (`{ (): void; extra: string }`) stays unsupported.
   */
  private _isPureFunction(type: ts.Type): boolean {
    return (
      type.getCallSignatures().length > 0 &&
      type.getConstructSignatures().length === 0 &&
      this._checker.getPropertiesOfType(type).length === 0 &&
      this._checker.getIndexInfosOfType(type).length === 0
    );
  }

  private _isGlobalDate(type: ts.Type): boolean {
    const symbol = type.getSymbol();
    if (symbol === undefined || symbol.getName() !== 'Date') {
      return false;
    }
    return (symbol.getDeclarations() ?? []).some(
      (declaration) => declaration.getSourceFile().hasNoDefaultLib,
    );
  }

  /**
   * Same heuristic as {@link _isGlobalDate}: the built-in collection interfaces
   * live in TypeScript lib files (`hasNoDefaultLib === true`), so a user type
   * that merely shares a name is not matched. `WeakMap`/`WeakSet` are
   * deliberately out of scope and stay unsupported.
   */
  private _getGlobalCollectionKind(type: ts.Type): 'map' | 'set' | undefined {
    const symbol = type.getSymbol();
    if (symbol === undefined) {
      return undefined;
    }
    const name = symbol.getName();
    const kind = MAP_NAMES.has(name) ? 'map' : SET_NAMES.has(name) ? 'set' : undefined;
    if (kind === undefined) {
      return undefined;
    }
    const isLibDeclaration = (symbol.getDeclarations() ?? []).some(
      (declaration) => declaration.getSourceFile().hasNoDefaultLib,
    );
    return isLibDeclaration ? kind : undefined;
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
      if (this._isValueObjectType(type)) {
        this._valueObjectDefinitionNames.add(definitionName);
      }
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

  /**
   * `Map<K, V>` and `ReadonlyMap<K, V>`: both key and value are resolved and
   * validated per entry. Mutations through `.set()` after validation are not
   * intercepted (see guards.ts).
   */
  private _resolveMap(type: ts.Type, node: ts.Node): CompoundResolution {
    const [keyType, valueType] = this._checker.getTypeArguments(type as ts.TypeReference);
    if (keyType === undefined || valueType === undefined) {
      return this._unsupported('Map key and value types could not be determined.');
    }
    const keyResolution = this._resolveType(keyType, node, true);
    if (keyResolution.schema === undefined) {
      return this._unsupported(`Map key is unsupported: ${keyResolution.reason ?? 'unknown type limit'}`);
    }
    const valueResolution = this._resolveType(valueType, node, true);
    if (valueResolution.schema === undefined) {
      return this._unsupported(`Map value is unsupported: ${valueResolution.reason ?? 'unknown type limit'}`);
    }
    return {
      status: 'partial',
      schema: { kind: 'map', key: keyResolution.schema, value: valueResolution.schema },
      reason: ALIAS_LIMIT_REASON,
    };
  }

  /**
   * `Set<T>` and `ReadonlySet<T>`: each item is resolved and validated.
   * Mutations through `.add()` after validation are not intercepted.
   */
  private _resolveSet(type: ts.Type, node: ts.Node): CompoundResolution {
    const [itemType] = this._checker.getTypeArguments(type as ts.TypeReference);
    if (itemType === undefined) {
      return this._unsupported('Set item type could not be determined.');
    }
    const itemResolution = this._resolveType(itemType, node, true);
    if (itemResolution.schema === undefined) {
      return this._unsupported(`Set item is unsupported: ${itemResolution.reason ?? 'unknown type limit'}`);
    }
    return {
      status: 'partial',
      schema: { kind: 'set', item: itemResolution.schema },
      reason: ALIAS_LIMIT_REASON,
    };
  }

  private _resolveObject(type: ts.Type, node: ts.Node): CompoundResolution {
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      return this._unsupported('Callable and constructable contracts are not represented by object schemas.');
    }
    // A ValueObject subclass is validated by identity (`instanceof` against its
    // constructor), never by its members. Its own methods and the inherited
    // String members are therefore not walked as properties at all.
    if (this._isValueObjectType(type)) {
      return {
        status: 'partial',
        schema: { kind: 'object', properties: {} },
        reason: ALIAS_LIMIT_REASON,
      };
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
      if (this._isConvertedToHashPrivate(property)) {
        // With enforcePrivate, the transformer rewrites this field into a real
        // `#private` field, so it has no reflective property at runtime and
        // must not be required by the structural schema. Only this member is
        // omitted; the rest of the class stays validated.
        continue;
      }
      if (this._isClassMethod(property)) {
        // Class methods keep the established contract: a class with a method is
        // not represented structurally. Only non-method members (fields holding
        // callbacks, interface method signatures) become function leaves.
        return this._unsupported(
          `Property ${propertyName} is unsupported: Callable and constructable contracts are not represented by object schemas.`,
        );
      }
      const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? node;
      const propertyType = this._checker.getTypeOfSymbolAtLocation(property, declaration);
      const propertyResolution = this._resolvePropertyType(propertyType, declaration);
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
          ...(this._isReadonlyPropertySignature(property) ? { readonly: true } : {}),
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

  /**
   * True only for a `readonly` member of an interface or type literal
   * (`ts.PropertySignature`). Class fields are deliberately excluded: they are
   * covered by `enforceReadonly`, which locks them after construction.
   * Known limitation: a `readonly` introduced by a mapped type such as
   * `Readonly<T>` is not detected, because the mapped symbol's value declaration
   * is the original (mutable) member.
   */
  private _isReadonlyPropertySignature(property: ts.Symbol): boolean {
    const declaration = property.valueDeclaration;
    if (declaration === undefined || !this._typescript.isPropertySignature(declaration)) {
      return false;
    }
    return (
      (this._typescript.getCombinedModifierFlags(declaration) & this._typescript.ModifierFlags.Readonly) !== 0
    );
  }

  /**
   * Mirrors the transformer's `isOnlyPrivateField` rule: with enforcePrivate,
   * a plain `private` PropertyDeclaration with an identifier name (not
   * protected, not static) is converted to a real `#private` field. Parameter
   * properties are not converted and remain part of the schema.
   */
  private _isConvertedToHashPrivate(property: ts.Symbol): boolean {
    if (!this._enforcePrivate) {
      return false;
    }
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (declaration === undefined || !this._typescript.isPropertyDeclaration(declaration)) {
      return false;
    }
    if (!this._typescript.isIdentifier(declaration.name)) {
      return false;
    }
    const flags = this._typescript.getCombinedModifierFlags(declaration);
    return (flags & this._typescript.ModifierFlags.Private) !== 0 &&
      (flags & (this._typescript.ModifierFlags.Protected | this._typescript.ModifierFlags.Static)) === 0;
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

  /**
   * True when the class type has `ValueObject` somewhere in its base-class
   * chain. Walks every ancestor, not just the immediate parent. The `visited`
   * set only guards against a malformed cycle; valid TypeScript cannot produce
   * one, so there is no artificial depth limit.
   */
  private _isValueObjectType(type: ts.Type): boolean {
    return this._extendsValueObject(type, new Set<ts.Type>());
  }

  private _extendsValueObject(type: ts.Type, visited: Set<ts.Type>): boolean {
    if (visited.has(type) || !type.isClassOrInterface()) {
      return false;
    }
    visited.add(type);
    for (const baseType of this._checker.getBaseTypes(type)) {
      if (this._isValueObjectBase(baseType) || this._extendsValueObject(baseType, visited)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Provenance check for the `ValueObject` base itself. The name alone is not
   * trusted: a user class named `ValueObject` must not match. The declaration
   * must be a class in this package's runtime file. This package's own source
   * (`runtime/value-object.class.ts`) or its installed declaration
   * (`runtime/value-object.class.d.ts` under `@ts-typed/compiler/`) both match.
   * This is a path heuristic, not a full package-identity check.
   */
  private _isValueObjectBase(baseType: ts.Type): boolean {
    const symbol = baseType.getSymbol();
    if (symbol === undefined || symbol.getName() !== 'ValueObject') {
      return false;
    }
    return (symbol.getDeclarations() ?? []).some(
      (declaration) =>
        this._typescript.isClassDeclaration(declaration) &&
        isValueObjectRuntimePath(declaration.getSourceFile().fileName),
    );
  }

  private _unsupported(reason: string): SchemaResolution & { readonly status: 'unsupported' } {
    return { status: 'unsupported', reason };
  }
}
