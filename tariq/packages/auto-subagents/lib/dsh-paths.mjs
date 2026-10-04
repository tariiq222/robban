// Runtime dependencies resolve through the package manifest; DSH_HOME controls only local data.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(here, '..');
export const DSH_HOME = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.resolve(PACKAGE_ROOT, '..', '..');

/** Resolve a declared host package export using Node's normal ESM resolution. */
export function runtimeModuleUrl(pkg, sub = 'lib/index.js') {
  if (sub !== 'lib/index.js') throw new Error('Auto requires a public package export, not an internal runtime path');
  return import.meta.resolve(pkg);
}
/** Absolute directory of a declared runtime package. */
export const runtimePackageDir = pkg => path.dirname(fileURLToPath(import.meta.resolve(`${pkg}/package.json`)));

export const RECIPES_DIR = process.env.DSH_AUTO_RECIPES_DIR ? path.resolve(process.env.DSH_AUTO_RECIPES_DIR) : path.join(DSH_HOME, 'recipes');
