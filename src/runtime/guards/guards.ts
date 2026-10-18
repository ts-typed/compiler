import { isExtraPropertiesAllowed } from '../allow-extra-properties.decorator';
import { isServerPopulated } from '../server-populated.decorator';
import { assertValue } from '../assert-value';
import type { AssertionContext } from '../assertion-context.interface';
import type {
  ArraySchema,
  MapSchema,
  ObjectPropertySchema,
  ObjectSchema,
  SchemaProperties,
  SetSchema,
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

/**
 * Mutation-guard proxies already created for an underlying array, so the same
 * array crossing the same typed boundary twice yields the same proxy.
 */
interface MutationGuardEntry {
  readonly schema: Schema;
  readonly context: AssertionContext;
  readonly proxy: unknown[];
}

const mutationGuardEntries = new WeakMap<object, MutationGuardEntry[]>();
const mutationGuardProxies = new WeakSet<object>();

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
  if (context.enforceMutationGuards === true) {
    if (Array.isArray(value)) {
      return guardArrayMutations(prepared.schema, value, prepared.context);
    }
    if (value instanceof Map) {
      return guardMapMutations(prepared.schema, value, prepared.context);
    }
    if (value instanceof Set) {
      return guardSetMutations(prepared.schema, value, prepared.context);
    }
    if (typeof value === 'object' && value !== null) {
      return guardObjectMutations(prepared.schema, value, prepared.context);
    }
  }
  return value;
}

/**
 * Returns a Proxy over `array` whose element and `length` writes are checked
 * against the array's item schema, so a later `push('wrong')` or
 * `arr[5] = 'wrong'` throws a `StrictTypeError` instead of succeeding. Only
 * `set` and `deleteProperty` are trapped: deletions (including the ones
 * `length` truncation performs internally) are forwarded unchanged, and
 * `length` writes are not validated because they introduce no element.
 * Schemas that do not resolve to an array (tuples, maps, sets, objects) are
 * returned untouched.
 */
function guardArrayMutations(
  schema: Schema,
  array: unknown[],
  context: AssertionContext,
  session: MutationSession = createMutationSession(),
): unknown[] {
  if (mutationGuardProxies.has(array)) {
    return array;
  }
  const resolved = resolveReference(schema, context);
  if (resolved.kind !== 'array') {
    return array;
  }
  const inProgress = sessionProxy(session, array, resolved);
  if (inProgress !== undefined) {
    return inProgress as unknown[];
  }

  const entries = mutationGuardEntries.get(array) ?? [];
  const existing = entries.find(
    (entry) =>
      entry.schema === resolved &&
      entry.context.propertyPath === context.propertyPath &&
      entry.context.registry === context.registry,
  );
  if (existing !== undefined) {
    return existing.proxy;
  }

  const items = resolved.items;
  const proxy = new Proxy(array, {
    set(target, property: string | symbol, nextValue: unknown): boolean {
      if (isArrayIndexKey(property)) {
        const itemContext: AssertionContext = {
          ...context,
          propertyPath: `${context.propertyPath}[${property}]`,
          operation: 'mutate',
        };
        assertValue(items, nextValue, itemContext);
        installProtection(items, nextValue, itemContext, createProtectionState());
        const stored = wrapMutationValue(items, nextValue, itemContext);
        return Reflect.set(target, property, stored, target);
      }
      return Reflect.set(target, property, nextValue, target);
    },
    deleteProperty(target, property: string | symbol): boolean {
      return Reflect.deleteProperty(target, property);
    },
  });

  entries.push({ schema: resolved, context, proxy });
  mutationGuardEntries.set(array, entries);
  mutationGuardProxies.add(proxy);
  rememberSessionProxy(session, array, resolved, proxy);
  wrapNestedArrayItems(array, resolved, context, session);
  return proxy;
}

function isArrayIndexKey(property: string | symbol): property is string {
  return (
    typeof property === 'string' &&
    /^(0|[1-9]\d*)$/.test(property) &&
    Number(property) < 4_294_967_295
  );
}

/**
 * Proxies already created for an underlying Map or Set, keyed by the
 * collection and reused when the same collection crosses the same boundary
 * again. Kept apart from `mutationGuardEntries` so the array path is untouched.
 */
interface CollectionMutationGuardEntry {
  readonly schema: Schema;
  readonly context: AssertionContext;
  readonly proxy: object;
}

const collectionMutationEntries = new WeakMap<object, CollectionMutationGuardEntry[]>();

/**
 * Map/Set counterpart of `guardArrayMutations`. Both collections keep their
 * entries in an internal slot that only the genuine `Map.prototype` /
 * `Set.prototype` methods can read, so a Proxy must never be used as `this`
 * for them: every read is performed on the real target, and only `set`
 * (Map) and `add` (Set) are replaced with validating wrappers. `delete` and
 * `clear` remove entries and cannot introduce a type violation, so they are
 * forwarded unchanged. The wrappers return the proxy so chained calls such as
 * `map.set(a, 1).set(b, 2)` keep going through the guarded version.
 */
function guardMapMutations(
  schema: Schema,
  map: Map<unknown, unknown>,
  context: AssertionContext,
  session: MutationSession = createMutationSession(),
): Map<unknown, unknown> {
  if (mutationGuardProxies.has(map)) {
    return map;
  }
  const resolved = resolveReference(schema, context);
  if (resolved.kind !== 'map') {
    return map;
  }
  const inProgress = sessionProxy(session, map, resolved);
  if (inProgress !== undefined) {
    return inProgress as Map<unknown, unknown>;
  }
  const existing = findCollectionMutationProxy(map, resolved, context);
  if (existing !== undefined) {
    return existing as Map<unknown, unknown>;
  }

  const keySchema = resolved.key;
  const valueSchema = resolved.value;
  const proxy: Map<unknown, unknown> = new Proxy(map, {
    get(target, property: string | symbol): unknown {
      if (property === 'set') {
        return (key: unknown, entryValue: unknown): Map<unknown, unknown> => {
          const keyContext = mutationEntryContext(context, `${context.propertyPath}<mutate>.key`);
          assertValue(keySchema, key, keyContext);
          installProtection(keySchema, key, keyContext, createProtectionState());
          const valueContext = mutationEntryContext(context, `${context.propertyPath}<mutate>.value`);
          assertValue(valueSchema, entryValue, valueContext);
          installProtection(valueSchema, entryValue, valueContext, createProtectionState());
          target.set(key, wrapMutationValue(valueSchema, entryValue, valueContext));
          return proxy;
        };
      }
      if (property === 'delete') {
        return (key: unknown): boolean => target.delete(key);
      }
      if (property === 'clear') {
        return (): void => target.clear();
      }
      const member = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });

  rememberCollectionMutationProxy(map, resolved, context, proxy);
  rememberSessionProxy(session, map, resolved, proxy);
  wrapNestedMapEntries(map, resolved, context, session);
  return proxy;
}

/**
 * Set counterpart of `guardMapMutations`: `add` validates the item before it
 * reaches the real set, and everything else is read from the real target.
 */
function guardSetMutations(
  schema: Schema,
  set: Set<unknown>,
  context: AssertionContext,
  session: MutationSession = createMutationSession(),
): Set<unknown> {
  if (mutationGuardProxies.has(set)) {
    return set;
  }
  const resolved = resolveReference(schema, context);
  if (resolved.kind !== 'set') {
    return set;
  }
  const inProgress = sessionProxy(session, set, resolved);
  if (inProgress !== undefined) {
    return inProgress as Set<unknown>;
  }
  const existing = findCollectionMutationProxy(set, resolved, context);
  if (existing !== undefined) {
    return existing as Set<unknown>;
  }

  const itemSchema = resolved.item;
  const proxy: Set<unknown> = new Proxy(set, {
    get(target, property: string | symbol): unknown {
      if (property === 'add') {
        return (item: unknown): Set<unknown> => {
          const itemContext = mutationEntryContext(context, `${context.propertyPath}<mutate>`);
          assertValue(itemSchema, item, itemContext);
          installProtection(itemSchema, item, itemContext, createProtectionState());
          target.add(wrapMutationValue(itemSchema, item, itemContext));
          return proxy;
        };
      }
      if (property === 'delete') {
        return (item: unknown): boolean => target.delete(item);
      }
      if (property === 'clear') {
        return (): void => target.clear();
      }
      const member = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });

  rememberCollectionMutationProxy(set, resolved, context, proxy);
  rememberSessionProxy(session, set, resolved, proxy);
  wrapNestedSetItems(set, resolved, context, session);
  return proxy;
}

function mutationEntryContext(context: AssertionContext, propertyPath: string): AssertionContext {
  return { ...context, propertyPath, operation: 'mutate' };
}

/**
 * Proxies created during one top-level wrap, keyed by the underlying value and
 * its resolved schema. A value reached again while its own wrap is still in
 * progress (a cycle, such as `node.self = node`) returns the proxy already
 * being built instead of recursing forever. The schema is part of the key so a
 * value reached at two different declared positions still gets the proxy for
 * each one. Every trap or nested wrap that needs one starts a fresh session.
 */
type MutationSession = Map<object, Map<Schema, object>>;

function createMutationSession(): MutationSession {
  return new Map();
}

function sessionProxy(session: MutationSession, value: object, schema: Schema): object | undefined {
  return session.get(value)?.get(schema);
}

function rememberSessionProxy(
  session: MutationSession,
  value: object,
  schema: Schema,
  proxy: object,
): void {
  const schemas = session.get(value) ?? new Map<Schema, object>();
  schemas.set(schema, proxy);
  session.set(value, schemas);
}

/**
 * Wraps `value` with the guard that matches its runtime shape and the declared
 * `schema`, recursively. A value that is not a reference, is already a guard
 * proxy, or does not match its schema's kind is returned as is. Used both when
 * a nested value is found already present (see the `wrapNested*` helpers) and
 * when a new value is written through a trap.
 */
function wrapMutationValue(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  session: MutationSession = createMutationSession(),
): unknown {
  if (!isReferenceValue(value) || mutationGuardProxies.has(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    const candidate = selectMutationSchema(schema, 'array', context);
    return candidate === undefined ? value : guardArrayMutations(candidate, value, context, session);
  }
  if (value instanceof Map) {
    const candidate = selectMutationSchema(schema, 'map', context);
    return candidate === undefined ? value : guardMapMutations(candidate, value, context, session);
  }
  if (value instanceof Set) {
    const candidate = selectMutationSchema(schema, 'set', context);
    return candidate === undefined ? value : guardSetMutations(candidate, value, context, session);
  }
  if (typeof value === 'object') {
    const candidate = selectMutationSchema(schema, 'object', context);
    return candidate === undefined ? value : guardObjectMutations(candidate, value, context, session);
  }
  return value;
}

/**
 * Finds the schema a runtime value of shape `kind` is checked against. An
 * optional property is declared as a union with `undefined`, so a union is
 * searched for its single member of that kind. A union with several members of
 * that kind is ambiguous and yields `undefined`, which leaves the value
 * unwrapped rather than guessing.
 */
function selectMutationSchema(
  schema: Schema,
  kind: 'array' | 'map' | 'set' | 'object',
  context: AssertionContext,
): Schema | undefined {
  const resolved = resolveReference(schema, context);
  if (resolved.kind === kind) {
    return resolved;
  }
  if (resolved.kind !== 'union') {
    return undefined;
  }
  const matches = resolved.schemas
    .map((member) => selectMutationSchema(member, kind, context))
    .filter((member): member is Schema => member !== undefined);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Wraps the array items present when the array's guard is created, writing each
 * wrapped item back onto the real array so later reads see the guarded version.
 */
function wrapNestedArrayItems(
  array: unknown[],
  schema: ArraySchema,
  context: AssertionContext,
  session: MutationSession,
): void {
  for (let index = 0; index < array.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (descriptor === undefined || isAccessorDescriptor(descriptor)) {
      continue;
    }
    const current = descriptor.value as unknown;
    const wrapped = wrapMutationValue(schema.items, current, indexedContext(context, index), session);
    if (wrapped !== current) {
      Reflect.set(array, String(index), wrapped, array);
    }
  }
}

/**
 * Wraps the Map entries present when the Map's guard is created. Values are
 * replaced in place with `target.set`, which keeps the key and its position.
 * Keys keep their identity (replacing a key would break lookups by the original
 * reference), so a key that is itself a structure is only walked: its own nested
 * children are wrapped in place, the key object is not replaced.
 */
function wrapNestedMapEntries(
  map: Map<unknown, unknown>,
  schema: MapSchema,
  context: AssertionContext,
  session: MutationSession,
): void {
  let index = 0;
  for (const [key, entryValue] of [...map]) {
    const keyContext = { ...context, propertyPath: `${context.propertyPath}<${index}>.key` };
    wrapMutationValue(schema.key, key, keyContext, session);
    const valueContext = { ...context, propertyPath: `${context.propertyPath}<${index}>.value` };
    const wrapped = wrapMutationValue(schema.value, entryValue, valueContext, session);
    if (wrapped !== entryValue) {
      map.set(key, wrapped);
    }
    index += 1;
  }
}

/**
 * Set items present before the guard existed cannot be replaced without
 * removing and re-adding them, which would change iteration order, so they are
 * not swapped for their wrapped versions. Each item is only walked: any nested
 * array, Map, Set or object inside it is wrapped in place, but the item itself
 * stays unguarded. Items added later through `add` are wrapped as they are added.
 */
function wrapNestedSetItems(
  set: Set<unknown>,
  schema: SetSchema,
  context: AssertionContext,
  session: MutationSession,
): void {
  let index = 0;
  for (const item of [...set]) {
    wrapMutationValue(schema.item, item, indexedContext(context, index), session);
    index += 1;
  }
}

/**
 * Wraps the declared properties present on a plain object when its guard is
 * created. Reads go through `Reflect.get` because installed guards are
 * accessors; the write-back goes through {@link storeMutationValue}.
 */
function wrapNestedObjectProperties(
  target: object,
  properties: SchemaProperties,
  context: AssertionContext,
  session: MutationSession,
): void {
  for (const key of Reflect.ownKeys(properties)) {
    if (Object.getOwnPropertyDescriptor(target, key) === undefined) {
      continue;
    }
    const current = Reflect.get(target, key, target) as unknown;
    const wrapped = wrapMutationValue(
      properties[key].schema,
      current,
      nestedContext(context, key),
      session,
    );
    if (wrapped !== current) {
      storeMutationValue(target, key, wrapped);
    }
  }
}

/**
 * Replaces the stored value of an own property with `value` without running
 * the guard's validation again. The value being stored is a proxy over a value
 * that already passed validation, and an installed readonly guard would refuse
 * a setter call, so the installed guard's stored value is updated directly.
 */
function storeMutationValue(owner: object, key: PropertyKey, value: unknown): void {
  const guard = getInstalledGuard(owner, key);
  if (guard !== undefined) {
    guard.value = value;
    return;
  }
  Reflect.set(owner, key, value, owner);
}

function findCollectionMutationProxy(
  collection: object,
  schema: Schema,
  context: AssertionContext,
): object | undefined {
  return (collectionMutationEntries.get(collection) ?? []).find(
    (entry) =>
      entry.schema === schema &&
      entry.context.propertyPath === context.propertyPath &&
      entry.context.registry === context.registry,
  )?.proxy;
}

function rememberCollectionMutationProxy(
  collection: object,
  schema: Schema,
  context: AssertionContext,
  proxy: object,
): void {
  const entries = collectionMutationEntries.get(collection) ?? [];
  entries.push({ schema, context, proxy });
  collectionMutationEntries.set(collection, entries);
  mutationGuardProxies.add(proxy);
}

/**
 * Plain-object counterpart of `guardArrayMutations`, for an object or interface
 * that crosses a typed boundary. The per-property accessors installed by
 * `installObjectProtection` cannot cover every write: on a sealed object the
 * properties are non-configurable, so the accessors are never installed and
 * the plain data properties stay writable; and a required key can be deleted
 * or redefined because the accessors are configurable. This Proxy closes
 * those paths with three traps:
 * - `set` validates a declared property's new value before the write;
 * - `deleteProperty` refuses to remove a required declared property;
 * - `defineProperty` refuses a declared property whose new `value` fails its schema.
 * A refusal returns `false` instead of throwing `StrictTypeError`, so the
 * engine itself produces the native error (a `delete` in strict code, or a
 * `TypeError` from `Object.defineProperty`), matching class instances.
 * Undeclared keys (extra properties and index signatures) are forwarded
 * untouched. Only objects whose prototype is `Object.prototype` or `null` are
 * wrapped, so class instances keep their identity and private-field semantics.
 */
function guardObjectMutations(
  schema: Schema,
  object: object,
  context: AssertionContext,
  session: MutationSession = createMutationSession(),
): object {
  if (mutationGuardProxies.has(object)) {
    return object;
  }
  const resolved = resolveReference(schema, context);
  if (resolved.kind !== 'object') {
    return object;
  }
  const prototype = Object.getPrototypeOf(object) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return object;
  }
  const inProgress = sessionProxy(session, object, resolved);
  if (inProgress !== undefined) {
    return inProgress;
  }
  const existing = findCollectionMutationProxy(object, resolved, context);
  if (existing !== undefined) {
    return existing;
  }

  const properties = resolved.properties;
  const declaredProperty = (property: string | symbol): ObjectPropertySchema | undefined =>
    Object.prototype.hasOwnProperty.call(properties, property) ? properties[property] : undefined;
  const propertyMutationContext = (property: string | symbol): AssertionContext => ({
    ...nestedContext(context, property),
    operation: 'mutate',
  });

  const proxy: object = new Proxy(object, {
    set(target, property: string | symbol, nextValue: unknown): boolean {
      const declared = declaredProperty(property);
      if (declared !== undefined) {
        const propertyContext = propertyMutationContext(property);
        assertValue(declared.schema, nextValue, propertyContext);
        installProtection(declared.schema, nextValue, propertyContext, createProtectionState());
        const stored = wrapMutationValue(declared.schema, nextValue, propertyContext);
        return Reflect.set(target, property, stored, target);
      }
      return Reflect.set(target, property, nextValue, target);
    },
    deleteProperty(target, property: string | symbol): boolean {
      const declared = declaredProperty(property);
      if (declared !== undefined && declared.optional !== true) {
        return false;
      }
      return Reflect.deleteProperty(target, property);
    },
    defineProperty(target, property: string | symbol, descriptor: PropertyDescriptor): boolean {
      const declared = declaredProperty(property);
      if (declared !== undefined && 'value' in descriptor) {
        const propertyContext = propertyMutationContext(property);
        if (!isValidValue(declared.schema, descriptor.value, propertyContext)) {
          return false;
        }
        installProtection(declared.schema, descriptor.value, propertyContext, createProtectionState());
        const stored = wrapMutationValue(declared.schema, descriptor.value, propertyContext);
        return Reflect.defineProperty(target, property, { ...descriptor, value: stored });
      }
      return Reflect.defineProperty(target, property, descriptor);
    },
  });

  rememberCollectionMutationProxy(object, resolved, context, proxy);
  rememberSessionProxy(session, object, resolved, proxy);
  wrapNestedObjectProperties(object, properties, context, session);
  return proxy;
}

/**
 * Non-throwing form of `assertValue`: reports a `StrictTypeError` mismatch as
 * `false` and rethrows anything else.
 */
function isValidValue(schema: Schema, value: unknown, context: AssertionContext): boolean {
  try {
    assertValue(schema, value, context);
    return true;
  } catch (error) {
    if (error instanceof StrictTypeError) {
      return false;
    }
    throw error;
  }
}

export function installFieldGuard(
  instance: object,
  key: PropertyKey,
  schema: Schema,
  context: AssertionContext,
  options: FieldGuardOptions,
): void {
  const fieldContext: AssertionContext = isServerPopulated(instance)
    ? { ...context, isServerPopulated: true }
    : context;
  const contract: GuardContract = {
    schema,
    context: fieldContext,
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

  const currentValue = descriptor === undefined ? undefined : descriptor.value;
  // A field with no inline initializer that keeps its PropertyDeclaration
  // in the output (decorated fields do, to preserve decorator emission —
  // see hasDecorators in create-contract-transformer.ts) is pre-defined by
  // native class fields as `undefined` before the constructor body runs,
  // which means a plain, non-accessor descriptor already exists here even
  // though nothing has really initialized it yet. Treating "a descriptor
  // exists" as "already handled by someone else" and bailing — the
  // previous behavior — silently skipped guard installation for every
  // such field, decorated or not. A real foreign value (anything other
  // than that `undefined` placeholder) is the only case worth treating as
  // already initialized here.
  const isInitialized = options.initialized || (descriptor !== undefined && currentValue !== undefined);
  if (isInitialized) {
    validateContract(contract, currentValue, context.operation);
    installContractProtection(contract, currentValue, context.operation);
  }

  installDataGuard(
    instance,
    key,
    currentValue,
    isInitialized,
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
    case 'map':
      if (value instanceof Map) {
        installMapEntryProtection(schema, value, context, state);
      }
      return;
    case 'set':
      if (value instanceof Set) {
        installSetItemProtection(schema, value, context, state);
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
  const ownerContext: AssertionContext = isServerPopulated(value)
    ? { ...context, isServerPopulated: true }
    : context;

  for (const key of declaredKeys) {
    const property = schema.properties[key];
    const propertyContext = nestedContext(ownerContext, key);
    const installedGuard = getInstalledGuard(value, key);
    if (installedGuard !== undefined) {
      addContractAndProtect(
        installedGuard,
        property.schema,
        property.readonly === true,
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
      property.readonly === true,
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
        false,
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
      false,
      propertyContext,
      state,
    );
  }
}

function addContractAndProtect(
  installedGuard: DataPropertyGuardState,
  schema: Schema,
  readonlyField: boolean,
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
  if (readonlyField) {
    lockStructuralReadonly(owner, key);
  }
  const prepared = prepareContract(contract, installedGuard.value, context.operation);
  installProtection(prepared.schema, installedGuard.value, prepared.context, state);
}

function installKnownDataProperty(
  owner: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
  schema: Schema,
  readonlyField: boolean,
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
  installDataGuard(owner, key, descriptor.value, true, descriptor, contract, readonlyField);
  if (readonlyField) {
    lockStructuralReadonly(owner, key);
  }
}

/**
 * Locks a `readonly` member of an interface/type-literal shape. Only applied
 * to plain object literals (prototype is `Object.prototype` or `null`): those
 * are complete when they cross a typed boundary, so there is no construction
 * phase to wait for. Class instances are skipped on purpose. Their own fields
 * may still be written by their methods, and a readonly view typed by an
 * interface must not freeze a class's mutable state.
 */
function lockStructuralReadonly(owner: object, key: PropertyKey): void {
  const prototype = Object.getPrototypeOf(owner) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return;
  }
  lockReadonlyField(owner, key);
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

/**
 * Protects the keys and values present when the contract is installed.
 * Entries added later through `.set()` are not intercepted (known limitation).
 */
function installMapEntryProtection(
  schema: MapSchema,
  value: Map<unknown, unknown>,
  context: AssertionContext,
  state: ProtectionState,
): void {
  let index = 0;
  for (const [key, entryValue] of value) {
    installProtection(schema.key, key, { ...context, propertyPath: `${context.propertyPath}<${index}>.key` }, state);
    installProtection(schema.value, entryValue, { ...context, propertyPath: `${context.propertyPath}<${index}>.value` }, state);
    index += 1;
  }
}

/**
 * Protects the items present when the contract is installed. Items added later
 * through `.add()` are not intercepted (known limitation).
 */
function installSetItemProtection(
  schema: SetSchema,
  value: Set<unknown>,
  context: AssertionContext,
  state: ProtectionState,
): void {
  let index = 0;
  for (const item of value) {
    installProtection(schema.item, item, indexedContext(context, index), state);
    index += 1;
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
    left.context.allowExtraPropertiesAll === right.context.allowExtraPropertiesAll &&
    left.context.isServerPopulated === right.context.isServerPopulated
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
