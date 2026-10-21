export type { FieldGuardOptions } from './field-guard-options.interface';
export {
  installFieldGuard,
  lockReadonlyField,
  lockRequiredField,
  protectValue,
  withDeferredReadonlyLock,
} from './guards';
export { protectOptimizedImmutableValue } from '../protect-optimized-immutable-value';
