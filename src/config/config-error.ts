export class ConfigError extends Error {
  public readonly code = 'INVALID_CONFIG';

  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
