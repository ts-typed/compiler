export interface BundleOptions {
  readonly minify: boolean;
  readonly sourceMap: boolean;
  readonly sourceMapRegister: boolean;
  readonly target: string;
  readonly externals: readonly string[];
  readonly cache: boolean;
  readonly license: string | null;
  readonly quiet: boolean;
  readonly debugLog: boolean;
}

export interface BundleAsset {
  readonly source: Buffer;
  readonly permissions?: number;
}

export interface BundleResult {
  readonly code: string;
  readonly map?: string;
  readonly assets: Readonly<Record<string, BundleAsset>>;
}
