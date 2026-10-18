import type { AssertionContext } from './assertion-context.interface';
import { SchemaRegistry } from './schema-registry.class';
import { getClassValidationMode } from './strict-class.decorator';
import type {
  ArraySchema,
  IntersectionSchema,
  MapSchema,
  ObjectPropertySchema,
  ObjectSchema,
  RefSchema,
  SetSchema,
  TupleSchema,
  UnionSchema,
} from './schema.interface';
import type { PrimitiveName, Schema } from './schema.type';
import { StrictTypeError } from './strict-type-error.class';
import type { StrictTypeErrorInfo } from './strict-type-error-info.interface';

interface ValidationState {
  readonly registry: SchemaRegistry;
  readonly visited: Map<object, Set<Schema>>;
}

const MAX_ARRAY_INDEX = 4_294_967_294;

export function assertValue(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
): void {
  const state: ValidationState = {
    registry: context.registry ?? new SchemaRegistry(),
    visited: new Map<object, Set<Schema>>(),
  };

  validate(schema, value, context, context.propertyPath, state);
}

function validate(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  if (schema.kind === 'ref') {
    validate(resolveReference(schema, state.registry), value, context, path, state);
    return;
  }

  if (isReferenceValue(value) && wasVisited(value, schema, state.visited)) {
    return;
  }

  switch (schema.kind) {
    case 'unknown':
      return;
    case 'never':
      fail(context, path, 'never', value, 'TYPE_MISMATCH');
    case 'function':
      if (typeof value !== 'function') {
        fail(context, path, 'function', value, 'TYPE_MISMATCH');
      }
      return;
    case 'templateLiteral':
      if (typeof value !== 'string' || !matchesTemplateLiteral(schema.pattern, value)) {
        fail(context, path, `template literal matching /${schema.pattern}/`, value, 'TYPE_MISMATCH');
      }
      return;
    case 'date':
      // An `Invalid Date` is still a Date instance; reject it here with a
      // contract error instead of letting it fail later with a RangeError.
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        fail(context, path, 'Date', value, 'TYPE_MISMATCH');
      }
      return;
    case 'primitive':
      if (!matchesPrimitive(schema.name, value)) {
        fail(context, path, schema.name, value, 'TYPE_MISMATCH');
      }
      return;
    case 'literal':
      if (schema.value !== value) {
        fail(context, path, literalName(schema.value), value, 'TYPE_MISMATCH');
      }
      return;
    case 'union':
      validateUnion(schema, value, context, path, state);
      return;
    case 'intersection':
      validateIntersection(schema, value, context, path, state);
      return;
    case 'array':
      validateArray(schema, value, context, path, state);
      return;
    case 'tuple':
      validateTuple(schema, value, context, path, state);
      return;
    case 'map':
      validateMap(schema, value, context, path, state);
      return;
    case 'set':
      validateSet(schema, value, context, path, state);
      return;
    case 'object':
      validateObject(schema, value, context, path, state);
  }
}

function validateUnion(
  schema: UnionSchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  for (const candidate of schema.schemas) {
    if (succeeds(candidate, value, context, path, state)) {
      return;
    }
  }

  fail(context, path, 'union', value, 'TYPE_MISMATCH');
}

function validateIntersection(
  schema: IntersectionSchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  const objectSchemas = schema.schemas.filter(isObjectSchema);

  if (objectSchemas.length === schema.schemas.length) {
    validateObject(combineObjectSchemas(objectSchemas), value, context, path, state);
    return;
  }

  if (!isReferenceValue(value)) {
    // Branded/tagged primitives (`string & { readonly __brand: 'Id' }`) are a
    // type-level trick: the object member has no runtime representation on a
    // primitive, so it is a phantom marker and must not be enforced against
    // the value. The primitive members still are.
    for (const candidate of schema.schemas) {
      const resolved =
        candidate.kind === 'ref' ? resolveReference(candidate, state.registry) : candidate;
      if (!isObjectSchema(resolved)) {
        validate(candidate, value, context, path, state);
      }
    }
    return;
  }

  for (const candidate of schema.schemas) {
    validate(candidate, value, context, path, state);
  }
}

function validateArray(
  schema: ArraySchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  if (!Array.isArray(value)) {
    fail(context, path, 'array', value, 'TYPE_MISMATCH');
  }

  for (let index = 0; index < value.length; index += 1) {
    validate(schema.items, value[index], context, `${path}[${index}]`, state);
  }

  validateArrayOwnProperties(value, context, path);
}

function validateTuple(
  schema: TupleSchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  if (!Array.isArray(value)) {
    fail(context, path, 'tuple', value, 'TYPE_MISMATCH');
  }

  if (schema.rest === undefined || schema.rest === false) {
    if (value.length !== schema.items.length) {
      fail(context, path, `tuple(${schema.items.length})`, value, 'TYPE_MISMATCH');
    }
  } else if (value.length < schema.items.length) {
    fail(context, path, 'tuple', value, 'TYPE_MISMATCH');
  }

  for (let index = 0; index < schema.items.length; index += 1) {
    validate(schema.items[index], value[index], context, `${path}[${index}]`, state);
  }

  if (schema.rest !== undefined && schema.rest !== false) {
    for (let index = schema.items.length; index < value.length; index += 1) {
      validate(schema.rest, value[index], context, `${path}[${index}]`, state);
    }
  }

  validateArrayOwnProperties(value, context, path);
}

/**
 * Map entries are addressed by their iteration index: `<path><i>.key` and
 * `<path><i>.value`. Array-style `[i]` is reserved for arrays and sets.
 */
function validateMap(
  schema: MapSchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  if (!(value instanceof Map)) {
    fail(context, path, 'Map', value, 'TYPE_MISMATCH');
  }

  let index = 0;
  for (const [key, entryValue] of value) {
    validate(schema.key, key, context, `${path}<${index}>.key`, state);
    validate(schema.value, entryValue, context, `${path}<${index}>.value`, state);
    index += 1;
  }
}

function validateSet(
  schema: SetSchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  if (!(value instanceof Set)) {
    fail(context, path, 'Set', value, 'TYPE_MISMATCH');
  }

  let index = 0;
  for (const item of value) {
    validate(schema.item, item, context, `${path}[${index}]`, state);
    index += 1;
  }
}

function validateObject(
  schema: ObjectSchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  if (!isReferenceValue(value) || Array.isArray(value)) {
    fail(context, path, 'object', value, 'TYPE_MISMATCH');
  }

  if (schema.instanceOf !== undefined && shouldEnforceInstanceOf(schema)) {
    if (!(value instanceof schema.instanceOf)) {
      fail(context, path, instanceOfName(schema.instanceOf), value, 'TYPE_MISMATCH');
    }
  }

  const declaredKeys = Reflect.ownKeys(schema.properties);

  for (const key of declaredKeys) {
    const property = schema.properties[key];
    const propertyPath = appendPropertyPath(path, key);

    if (!Reflect.has(value, key)) {
      if (property.optional !== true) {
        fail(context, propertyPath, 'required property', value, 'REQUIRED_PROPERTY');
      }
      continue;
    }

    const propertyValue = Reflect.get(value, key);
    if (property.deferredAssignment === true && propertyValue === undefined) {
      continue;
    }
    validate(property.schema, propertyValue, context, propertyPath, state);
  }

  const knownKeys = new Set<PropertyKey>(declaredKeys);

  for (const key of Reflect.ownKeys(value)) {
    if (knownKeys.has(key)) {
      continue;
    }

    const propertyPath = appendPropertyPath(path, key);
    if (schema.index !== undefined) {
      validate(schema.index, Reflect.get(value, key), context, propertyPath, state);
      continue;
    }

    if (schema.allowExtraProperties !== true && context.allowExtraPropertiesAll !== true) {
      fail(context, propertyPath, 'no extra properties', value, 'EXTRA_PROPERTY');
    }
  }
}

function validateArrayOwnProperties(
  value: readonly unknown[],
  context: AssertionContext,
  path: string,
): void {
  if (context.allowExtraPropertiesAll === true) {
    return;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length' || (typeof key === 'string' && isArrayIndex(key))) {
      continue;
    }

    fail(context, appendPropertyPath(path, key), 'no extra properties', value, 'EXTRA_PROPERTY');
  }
}

function combineObjectSchemas(schemas: readonly ObjectSchema[]): ObjectSchema {
  const propertiesByKey = new Map<PropertyKey, ObjectPropertySchema>();
  const indexSchemas: Schema[] = [];

  for (const schema of schemas) {
    for (const key of Reflect.ownKeys(schema.properties)) {
      const property = schema.properties[key];
      const existing = propertiesByKey.get(key);

      if (existing === undefined) {
        propertiesByKey.set(key, property);
        continue;
      }

      propertiesByKey.set(key, {
        schema: {
          kind: 'intersection',
          schemas: [existing.schema, property.schema],
        },
        ...(existing.optional === true && property.optional === true
          ? { optional: true }
          : {}),
      });
    }

    if (schema.index !== undefined) {
      indexSchemas.push(schema.index);
    }
  }

  return {
    kind: 'object',
    properties: Object.fromEntries(propertiesByKey),
    ...(schemas.length > 0 && schemas.every((schema) => schema.allowExtraProperties === true)
      ? { allowExtraProperties: true }
      : {}),
    ...(indexSchemas.length === 1
      ? { index: indexSchemas[0] }
      : indexSchemas.length > 1
        ? { index: { kind: 'intersection', schemas: indexSchemas } }
        : {}),
  };
}

function resolveReference(schema: RefSchema, registry: SchemaRegistry): Schema {
  const referencePath: string[] = [];
  const visitedNames = new Set<string>();
  let current: Schema = schema;

  while (current.kind === 'ref') {
    if (visitedNames.has(current.name)) {
      referencePath.push(current.name);
      throw new Error(
        `SchemaRegistry reference cycle has no concrete schema: ${referencePath.join(' -> ')}`,
      );
    }

    visitedNames.add(current.name);
    referencePath.push(current.name);
    const target = registry.get(current.name);

    if (target === undefined) {
      throw new Error(`SchemaRegistry has no schema named "${current.name}"`);
    }

    current = target;
  }

  return current;
}

function succeeds(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): boolean {
  try {
    validate(schema, value, context, path, cloneState(state));
    return true;
  } catch (error: unknown) {
    if (error instanceof StrictTypeError) {
      return false;
    }
    throw error;
  }
}

function cloneState(state: ValidationState): ValidationState {
  const visited = new Map<object, Set<Schema>>();

  for (const [value, schemas] of state.visited) {
    visited.set(value, new Set<Schema>(schemas));
  }

  return { registry: state.registry, visited };
}

function wasVisited(
  value: object,
  schema: Schema,
  visited: Map<object, Set<Schema>>,
): boolean {
  const schemas = visited.get(value) ?? new Set<Schema>();

  if (schemas.has(schema)) {
    return true;
  }

  schemas.add(schema);
  visited.set(value, schemas);
  return false;
}

function isObjectSchema(schema: Schema): schema is ObjectSchema {
  return schema.kind === 'object';
}

function shouldEnforceInstanceOf(schema: ObjectSchema): boolean {
  if (schema.instanceOf === undefined) {
    return false;
  }
  const override = getClassValidationMode(schema.instanceOf);
  return override === undefined ? schema.strictClassDefault === true : override === 'strict';
}

function instanceOfName(constructor: Function): string {
  return constructor.name.length > 0 ? constructor.name : 'class instance';
}

function isArrayIndex(key: string): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index <= MAX_ARRAY_INDEX &&
    String(index) === key
  );
}

function matchesPrimitive(name: PrimitiveName, value: unknown): boolean {
  if (name === 'null') {
    return value === null;
  }
  if (name === 'object') {
    return typeof value === 'object' && value !== null;
  }
  return typeof value === name;
}

function appendPropertyPath(path: string, key: PropertyKey): string {
  return typeof key === 'symbol' ? `${path}[${String(key)}]` : `${path}.${key}`;
}

function literalName(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function isReferenceValue(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function receivedName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

const templateLiteralPatterns = new Map<string, RegExp>();

function matchesTemplateLiteral(pattern: string, value: string): boolean {
  let regex = templateLiteralPatterns.get(pattern);
  if (regex === undefined) {
    regex = new RegExp(pattern);
    templateLiteralPatterns.set(pattern, regex);
  }
  return regex.test(value);
}

function fail(
  context: AssertionContext,
  path: string,
  expected: string,
  value: unknown,
  code: StrictTypeErrorInfo['code'],
): never {
  throw new StrictTypeError({
    code,
    ...(context.className === undefined ? {} : { className: context.className }),
    ...(context.functionName === undefined ? {} : { functionName: context.functionName }),
    ...(context.isServerPopulated === true ? { isServerPopulated: true } : {}),
    contractKind: context.contractKind,
    propertyPath: path,
    expected,
    received: receivedName(value),
    operation: context.operation,
  });
}
