import type { BundleOptions, BundleResult } from './bundle-options.interface';

type NccEmit = (
  entry: string,
  options: Record<string, unknown>,
) => Promise<{
  readonly code: string;
  readonly map?: string;
  readonly assets: Readonly<Record<string, { readonly source: Buffer; readonly permissions?: number }>>;
}>;

export async function bundleProject(
  entryFile: string,
  options: BundleOptions,
): Promise<BundleResult> {
  const ncc = require('@vercel/ncc') as NccEmit;
  const result = await ncc(entryFile, {
    cache: options.cache ? undefined : false,
    externals: [...options.externals],
    minify: options.minify,
    sourceMap: options.sourceMap,
    sourceMapRegister: options.sourceMapRegister,
    license: options.license ?? '',
    target: options.target,
    quiet: options.quiet,
    debugLog: options.debugLog,
  });

  return {
    code: result.code,
    ...(result.map === undefined ? {} : { map: result.map }),
    assets: result.assets,
  };
}
