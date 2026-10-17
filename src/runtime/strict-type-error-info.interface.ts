import type { AssertionContext } from './assertion-context.interface';
import type { StrictTypeErrorCode } from './strict-type-error-code.type';

export interface StrictTypeErrorInfo {
  readonly code: StrictTypeErrorCode;
  readonly className?: string;
  readonly functionName?: string;
  readonly contractKind: AssertionContext['contractKind'];
  readonly propertyPath: string;
  readonly expected: string;
  readonly received: string;
  readonly operation: AssertionContext['operation'];
}
