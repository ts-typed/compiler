import type { IntegrationErrorCode } from './integration-error-code.type';

export class IntegrationError extends Error {
  public readonly code: IntegrationErrorCode;

  public constructor(code: IntegrationErrorCode, message: string) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
  }
}
