import { isExtraPropertiesAllowed } from '../allow-extra-properties.decorator';
import { assertValue } from '../assert-value';
import type { AssertionContext } from '../assertion-context.interface';
import type {
  ArraySchema,
  ObjectPropertySchema,
  ObjectSchema,
  SchemaProperties,
  TupleSchema,
} from '../schema.interface';
import type { Schema } from '../schema.type';
import { StrictTypeError } from '../strict-type-error.class';
import type { FieldGuardOptions } from './field-guard-options.interface';

interface GuardContract {
  readonly schema: Schema;
  readonly context: AssertionContext;
  readonly allowDirectExtraProperties: boolean;
}

interface DataPropertyGuardState {
  readonly contracts: GuardContract[];
  readonly getValue: () => unknown;
  readonly setValue: (value: unknown) => void;
  value: unknown;
  isInitialized: boolean;
  isReadonlyField: boolean;
  isLocked: boolean;
}

interface ProtectionState {
  readonly visited: Map<object, Set<Schema>>;
}

interface PreparedContract {
  readonly schema: Schema;
  readonly context: AssertionContext;
}

const installedDataGuards = new WeakMap<
  object,
  Map<PropertyKey, DataPropertyGuardState>
>();

export function protectValue(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
): unknown {
  const contract: GuardContract = {
    schema,
    context,
    allowDirectExtraProperties: false,
  };
  const prepared = prepareContract(contract, value, context.operation);

  assertValue(prepared.schema, value, prepared.context);
  installProtection(prepared.schema, value, prepared.context, createProtectionState());
  return value;
}

export function installFieldGuard(
  instance: object,
  key: PropertyKey,
  schema: Schema,
  context: AssertionContext,
  options: FieldGuardOptions,
): void {
  const contract: GuardContract = {
    schema,
    context,
    allowDirectExtraProperties:
      options.allowExtraProperties === true ||
      isExtraPropertiesAllowed(instance, decoratorPropertyKey(key)),
  };
  const existingGuard = getInstalledGuard(instance, key);

  if (existingGuard !== undefined) {
    const shouldValidate = existingGuard.isInitialized || options.initialized;
    if (shouldValidate) {
      validateContract(contract, existingGuard.value, context.operation);
    }
    addContract(existingGuard, contract);
    existingGuard.isInitialized = shouldValidate;
    existingGuard.isReadonlyField = existingGuard.isReadonlyField || options.readonlyField === true;
    if (shouldValidate) {
      installContractProtection(contract, existingGuard.value, context.operation);
    }
    return;
  }

  const descriptor = Object.getOwnPropertyDescriptor(instance, key);
  if (isAccessorDescriptor(descriptor)) {
    if (options.initialized) {
      validateContract(contract, Reflect.get(instance, key), context.operation);
    }
    return;
  }

  if (!options.initialized && descriptor !== undefined) {
    return;
  }

  const currentValue = descriptor === undefined ? undefined : descriptor.value;
  if (options.initialized) {
    validateContract(contract, currentValue, context.operation);
    installContractProtection(contract, currentValue, context.operation);
  }

  installDataGuard(
    instance,
    key,
    currentValue,
    options.initialized,
    descriptor,
    contract,
    options.readonlyField === true,
  );
}

/**
 * Locks a `readonly` field installed by {@link installFieldGuard} with
 * `{readonlyField: true}` against further writes. The compiler calls this
 * once, as the last statement of the field's declaring class's own
 * constructor — matching TypeScript's own rule that a `readonly` field may
 * be (re)assigned any number of times while that constructor is still
 * running, and never again afterward. A key with no guard installed (for
 * example because {@link installFieldGuard} could not take over a
 * non-configurable property) is a harmless no-op: there is nothing to lock.
 */
export function lockReadonlyField(instance: object, key: PropertyKey): void {
  const guard = getInstalledGuard(instance, key);
  if (guard !== undefined) {
    guard.isLocked = true;
  }
}

/**
 * Makes a required field's guarded accessor non-configurable, so that
 * `delete instance.field` and `Object.defineProperty(instance, 'field', …)`
 * can no longer remove or replace it behind the guarded setter's back. The
 * compiler calls this once `new.target` confirms construction has reached
 * the most-derived class for this instance — never from a base class's own
 * constructor, and never unconditionally at install time in
 * {@link installFieldGuard} — because a subclass that redeclares this same
 * field re-initializes it through `[[DefineOwnProperty]]` semantics in ITS
 * OWN constructor (which runs after the base class constructor returns),
 * and that requires the property to still be configurable until then. A
 * missing or already non-configurable property is a harmless no-op.
 */
export function lockRequiredField(instance: object, key: PropertyKey): void {
  const descriptor = Object.getOwnPropertyDescriptor(instance, key);
  if (descriptor === undefined || descriptor.configurable === false) {
    return;
  }
  try {
    Object.defineProperty(instance, key, { configurable: false });
  } catch {
    // Non-configurable already, or the engine refused for an unrelated
    // reason (e.g. a proxy trap) — either way, nothing more to do here.
  }
}

function createProtectionState(): ProtectionState {
  return { visited: new Map<object, Set<Schema>>() };
}

function validateContract(
  contract: GuardContract,
  value: unknown,
  operation: AssertionContext['operation'],
): void {
  const prepared = prepareContract(contract, value, operation);
  assertValue(prepared.schema, value, prepared.context);
}

function installContractProtection(
  contract: GuardContract,
  value: unknown,
  operation: AssertionContext['operation'],
): void {
  const prepared = prepareContract(contract, value, operation);
  installProtection(prepared.schema, value, prepared.context, createProtectionState());
}

function prepareContract(
  contract: GuardContract,
  value: unknown,
  operation: AssertionContext['operation'],
): PreparedContract {
  const context: AssertionContext = { ...contract.context, operation };
  let schema = contract.schema;

  if (contract.allowDirectExtraProperties) {
    schema = allowFieldExtraProperties(schema, context);
  }

  if (isReferenceValue(value) && !Array.isArray(value)) {
    schema = applyObjectDecoratorPermissions(schema, value, context);
  }

  return { schema, context };
}

function applyObjectDecoratorPermissions(
  schema: Schema,
  owner: object,
  context: AssertionContext,
): Schema {
  const resolved = resolveReference(schema, context);
  if (resolved.kind === 'object') {
    return prepareObjectSchema(resolved, owner, context);
  }
  if (resolved.kind === 'intersection') {
    return {
      kind: 'intersection',
      schemas: resolved.schemas.map((candidate) =>
        applyObjectDecoratorPermissions(candidate, owner, context),
      ),
    };
  }
  if (resolved.kind === 'union') {
    return {
      kind: 'union',
      schemas: resolved.schemas.map((candidate) =>
        applyObjectDecoratorPermissions(candidate, owner, context),
      ),
    };
  }
  return resolved;
}

function prepareObjectSchema(
  schema: ObjectSchema,
  owner: object,
  context: AssertionContext,
): ObjectSchema {
  const hasClassPermission = isExtraPropertiesAllowed(owner);
  const properties = clonePropertiesWithDecoratorPermissions(
    schema.properties,
    owner,
    context,
  );

  if (!hasClassPermission && properties === schema.properties) {
    return schema;
  }

  return {
    ...schema,
    properties,
    ...(hasClassPermission ? { allowExtraProperties: true } : {}),
  };
}

function clonePropertiesWithDecoratorPermissions(
  properties: SchemaProperties,
  owner: object,
  context: AssertionContext,
): SchemaProperties {
  let transformed: SchemaProperties | undefined;

  for (const key of Reflect.ownKeys(properties)) {
    if (!isExtraPropertiesAllowed(owner, key)) {
      continue;
    }

    if (transformed === undefined) {
      transformed = cloneSchemaProperties(properties);
    }
    const property = properties[key];
    Object.defineProperty(transformed, key, {
      value: {
        ...property,
        schema: allowFieldExtraProperties(property.schema, context),
      } satisfies ObjectPropertySchema,
      enumerable: true,
      configurable: true,
    });
  }

  return transformed ?? properties;
}

function cloneSchemaProperties(properties: SchemaProperties): SchemaProperties {
  const cloned: Record<PropertyKey, ObjectPropertySchema> = Object.create(null);

  for (const key of Reflect.ownKeys(properties)) {
    Object.defineProperty(cloned, key, {
      value: properties[key],
      enumerable: true,
      configurable: true,
    });
  }

  return cloned;
}

function allowFieldExtraProperties(
  schema: Schema,
  context: AssertionContext,
): Schema {
  const resolved = resolveReference(schema, context);
  if (resolved.kind === 'array') {
    return { ...resolved, items: allowDirectObjectExtras(resolved.items, context) };
  }
  if (resolved.kind === 'tuple') {
    return {
      ...resolved,
      items: resolved.items.map((item) => allowDirectObjectExtras(item, context)),
      ...(resolved.rest === undefined || resolved.rest === false
        ? {}
        : { rest: allowDirectObjectExtras(resolved.rest, context) }),
    };
  }
  return allowDirectObjectExtras(resolved, context);
}

function allowDirectObjectExtras(
  schema: Schema,
  context: AssertionContext,
): Schema {
  const resolved = resolveReference(schema, context);
  if (resolved.kind === 'object') {
    return { ...resolved, allowExtraProperties: true };
  }
  if (resolved.kind === 'intersection') {
    return {
      kind: 'intersection',
      schemas: resolved.schemas.map((candidate) =>
        allowDirectObjectExtras(candidate, context),
      ),
    };
  }
  if (resolved.kind === 'union') {
    return {
      kind: 'union',
      schemas: resolved.schemas.map((candidate) =>
        allowDirectObjectExtras(candidate, context),
      ),
    };
  }
  return resolved;
}

function installProtection(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  state: ProtectionState,
): void {
  if (!isReferenceValue(value)) {
    return;
  }
  if (wasVisited(value, schema, state)) {
    return;
  }

  if (schema.kind === 'ref') {
    installProtection(resolveReference(schema, context), value, context, state);
    return;
  }

  switch (schema.kind) {
    case 'object':
      if (!Array.isArray(value)) {
        installObjectProtection(schema, value, context, state);
      }
      return;
    case 'array':
      if (Array.isArray(value)) {
        installArrayItemProtection(schema, value, context, state);
      }
      return;
    case 'tuple':
      if (Array.isArray(value)) {
        installTupleItemProtection(schema, value, context, state);
      }
      return;
    case 'intersection':
      for (const candidate of schema.schemas) {
        installProtection(candidate, value, context, state);
      }
      return;
    case 'union':
    case 'literal':
    case 'never':
    case 'primitive':
    case 'date':
    case 'function':
    case 'templateLiteral':
    case 'unknown':
      return;
  }
}

function installObjectProtection(
  schema: ObjectSchema,
  value: object,
  context: AssertionContext,
  state: ProtectionState,
): void {
  const declaredKeys = new Set<PropertyKey>(Reflect.ownKeys(schema.properties));

  for (const key of declaredKeys) {
    const property = schema.properties[key];
    const propertyContext = nestedContext(context, key);
    const installedGuard = getInstalledGuard(value, key);
    if (installedGuard !== undefined) {
      addContractAndProtect(
        installedGuard,
        property.schema,
        propertyContext,
        value,
        key,
        state,
      );
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || isAccessorDescriptor(descriptor)) {
      continue;
    }

    installKnownDataProperty(
      value,
      key,
      descriptor,
      property.schema,
      propertyContext,
      state,
    );
  }

  if (schema.index === undefined) {
    return;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (declaredKeys.has(key)) {
      continue;
    }
    const propertyContext = nestedContext(context, key);
    const installedGuard = getInstalledGuard(value, key);
    if (installedGuard !== undefined) {
      addContractAndProtect(
        installedGuard,
        schema.index,
        propertyContext,
        value,
        key,
        state,
      );
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || isAccessorDescriptor(descriptor)) {
      continue;
    }
    installKnownDataProperty(
      value,
      key,
      descriptor,
      schema.index,
      propertyContext,
      state,
    );
  }
}

function addContractAndProtect(
  installedGuard: DataPropertyGuardState,
  schema: Schema,
  context: AssertionContext,
  owner: object,
  key: PropertyKey,
  state: ProtectionState,
): void {
  const contract: GuardContract = {
    schema,
    context,
    allowDirectExtraProperties: isExtraPropertiesAllowed(
      owner,
      decoratorPropertyKey(key),
    ),
  };
  addContract(installedGuard, contract);
  const prepared = prepareContract(contract, installedGuard.value, context.operation);
  installProtection(prepared.schema, installedGuard.value, prepared.context, state);
}

function installKnownDataProperty(
  owner: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
  schema: Schema,
  context: AssertionContext,
  state: ProtectionState,
): void {
  const contract: GuardContract = {
    schema,
    context,
    allowDirectExtraProperties: isExtraPropertiesAllowed(
      owner,
      decoratorPropertyKey(key),
    ),
  };
  const prepared = prepareContract(contract, descriptor.value, context.operation);

  installProtection(prepared.schema, descriptor.value, prepared.context, state);
  installDataGuard(owner, key, descriptor.value, true, descriptor, contract, false);
}

function installArrayItemProtection(
  schema: ArraySchema,
  value: readonly unknown[],
  context: AssertionContext,
  state: ProtectionState,
): void {
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || isAccessorDescriptor(descriptor)) {
      continue;
    }
    installProtection(
      schema.items,
      descriptor.value,
      indexedContext(context, index),
      state,
    );
  }
}

function installTupleItemProtection(
  schema: TupleSchema,
  value: readonly unknown[],
  context: AssertionContext,
  state: ProtectionState,
): void {
  for (let index = 0; index < value.length; index += 1) {
    const itemSchema =
      schema.items[index] ??
      (schema.rest === undefined || schema.rest === false ? undefined : schema.rest);
    if (itemSchema === undefined) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || isAccessorDescriptor(descriptor)) {
      continue;
    }
    installProtection(
      itemSchema,
      descriptor.value,
      indexedContext(context, index),
      state,
    );
  }
}

function installDataGuard(
  owner: object,
  key: PropertyKey,
  value: unknown,
  isInitialized: boolean,
  descriptor: PropertyDescriptor | undefined,
  contract: GuardContract,
  readonlyField: boolean,
): void {
  const existingGuard = getInstalledGuard(owner, key);
  if (existingGuard !== undefined) {
    addContract(existingGuard, contract);
    existingGuard.isInitialized = existingGuard.isInitialized || isInitialized;
    existingGuard.isReadonlyField = existingGuard.isReadonlyField || readonlyField;
    return;
  }

  if (!canInstallDataGuard(owner, descriptor)) {
    return;
  }

  const contracts: GuardContract[] = [contract];
  const guardState: DataPropertyGuardState = {
    contracts,
    value,
    isInitialized,
    isReadonlyField: readonlyField,
    isLocked: false,
    getValue: (): unknown => guardState.value,
    setValue: (nextValue: unknown): void => {
      setGuardedValue(guardState, nextValue);
    },
  };

  try {
    // Always installed as configurable: a subclass that redeclares this
    // same field re-initializes it through `[[DefineOwnProperty]]` semantics
    // (native class fields, target >= ES2022) in ITS OWN constructor, which
    // requires the property to still be configurable at that point. Locking
    // a required field against `delete`/`Object.defineProperty` happens
    // later and separately, via {@link lockRequiredField}, once construction
    // has reached the most-derived class and no further redeclaration can
    // happen — see that function's own doc comment.
    Object.defineProperty(owner, key, {
      get: guardState.getValue,
      set: guardState.setValue,
      enumerable: descriptor?.enumerable ?? true,
      configurable: true,
    });
  } catch {
    return;
  }

  const guards = installedDataGuards.get(owner) ??
    new Map<PropertyKey, DataPropertyGuardState>();
  guards.set(key, guardState);
  installedDataGuards.set(owner, guards);
}

function addContract(
  state: DataPropertyGuardState,
  contract: GuardContract,
): void {
  if (state.contracts.some((existing) => contractsMatch(existing, contract))) {
    return;
  }
  state.contracts.push(contract);
}

function contractsMatch(
  left: GuardContract,
  right: GuardContract,
): boolean {
  return (
    left.schema === right.schema &&
    left.allowDirectExtraProperties === right.allowDirectExtraProperties &&
    left.context.propertyPath === right.context.propertyPath &&
    left.context.contractKind === right.context.contractKind &&
    left.context.className === right.context.className &&
    left.context.functionName === right.context.functionName &&
    left.context.registry === right.context.registry &&
    left.context.allowExtraPropertiesAll === right.context.allowExtraPropertiesAll
  );
}

function setGuardedValue(state: DataPropertyGuardState, value: unknown): void {
  if (state.isLocked) {
    const context = state.contracts[0]?.context;
    throw new StrictTypeError({
      code: 'READONLY_PROPERTY',
      ...(context?.className === undefined ? {} : { className: context.className }),
      ...(context?.functionName === undefined ? {} : { functionName: context.functionName }),
      contractKind: context?.contractKind ?? 'property',
      propertyPath: context?.propertyPath ?? '<unknown>',
      expected: 'no further writes',
      received: 'write attempt',
      operation: 'set',
    });
  }

  const preparedContracts = state.contracts.map((contract) =>
    prepareContract(contract, value, 'set'),
  );

  for (const prepared of preparedContracts) {
    assertValue(prepared.schema, value, prepared.context);
  }

  for (const prepared of preparedContracts) {
    installProtection(
      prepared.schema,
      value,
      prepared.context,
      createProtectionState(),
    );
  }

  state.value = value;
  state.isInitialized = true;
}

function getInstalledGuard(
  owner: object,
  key: PropertyKey,
): DataPropertyGuardState | undefined {
  const guard = installedDataGuards.get(owner)?.get(key);
  if (guard === undefined) {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (
    descriptor?.get !== guard.getValue ||
    descriptor.set !== guard.setValue
  ) {
    installedDataGuards.get(owner)?.delete(key);
    return undefined;
  }

  return guard;
}

function canInstallDataGuard(
  owner: object,
  descriptor: PropertyDescriptor | undefined,
): boolean {
  if (descriptor === undefined) {
    return Object.isExtensible(owner);
  }
  return (
    descriptor.configurable === true &&
    descriptor.writable === true &&
    !isAccessorDescriptor(descriptor)
  );
}

function isAccessorDescriptor(
  descriptor: PropertyDescriptor | undefined,
): boolean {
  return descriptor !== undefined && ('get' in descriptor || 'set' in descriptor);
}

function wasVisited(
  value: object,
  schema: Schema,
  state: ProtectionState,
): boolean {
  const schemas = state.visited.get(value) ?? new Set<Schema>();
  if (schemas.has(schema)) {
    return true;
  }
  schemas.add(schema);
  state.visited.set(value, schemas);
  return false;
}

function resolveReference(
  schema: Schema,
  context: AssertionContext,
): Schema {
  if (schema.kind !== 'ref') {
    return schema;
  }

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
    const target: Schema | undefined = context.registry?.get(current.name);
    if (target === undefined) {
      throw new Error(`SchemaRegistry has no schema named "${current.name}"`);
    }
    current = target;
  }

  return current;
}

function nestedContext(
  context: AssertionContext,
  key: PropertyKey,
): AssertionContext {
  return {
    ...context,
    propertyPath:
      typeof key === 'symbol'
        ? `${context.propertyPath}[${String(key)}]`
        : `${context.propertyPath}.${key}`,
  };
}

function indexedContext(
  context: AssertionContext,
  index: number,
): AssertionContext {
  return { ...context, propertyPath: `${context.propertyPath}[${index}]` };
}

function isReferenceValue(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function decoratorPropertyKey(key: PropertyKey): string | symbol {
  return typeof key === 'number' ? String(key) : key;
}
