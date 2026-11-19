import fs from 'node:fs';
import path from 'node:path';

// Writes a file in full or not at all: a temporary file next to it, then a rename.
export function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

// The parsed file, or null when it is absent. A file that exists and cannot be
// parsed is an error, so a damaged file is not read as "no data".
export function readJsonIfExists(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(text);
}

// Creates the file only if no file of that name exists (append only history).
export function writeJsonExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
