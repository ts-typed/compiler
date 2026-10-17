export interface ProjectResolution {
  readonly apiVersion: 1;
  readonly integration: string;
  readonly projectRoot: string;
  readonly configPath?: string;
}
