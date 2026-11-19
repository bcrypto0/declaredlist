// Loads the public checker (addon-declare) by path. Its code is imported, not
// copied. The path is the sibling folder ../public-repo/addon-declaration by
// default, or the folder named by DECLARED_CHECKER_DIR (for CI, a clone).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHECKER_SOURCE = 'https://github.com/bcrypto0/addon-declaration';
export const CHECKER_ISSUES = 'https://github.com/bcrypto0/addon-declaration/issues';

export function checkerDir(env = process.env) {
  if (env.DECLARED_CHECKER_DIR) return path.resolve(env.DECLARED_CHECKER_DIR);
  return path.resolve(SITE_ROOT, '..', 'public-repo', 'addon-declaration');
}

export async function loadChecker(dir = checkerDir()) {
  const lib = (f) => pathToFileURL(path.join(dir, 'lib', f)).href;
  if (!fs.existsSync(path.join(dir, 'lib', 'listing.js'))) {
    throw new Error('the checker was not found; set DECLARED_CHECKER_DIR to a clone of the public checker');
  }
  const [listing, resolve, declaration] = await Promise.all([import(lib('listing.js')), import(lib('resolve.js')), import(lib('declaration.js'))]);
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    version = null;
  }
  return { listing, resolve, declaration, version };
}
