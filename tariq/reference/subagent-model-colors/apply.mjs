import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Exact-version local patch. Fail closed after upstream updates; never replace an unknown bundle.
const target = '/Users/tariq/.local/share/deepseek-harness/runtime/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js';
const original = readFileSync(new URL('./client.original.js', import.meta.url));
const patched = readFileSync(new URL('./client.patched.js', import.meta.url));
const current = readFileSync(target);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (hash(current) === hash(patched)) {
  console.log('Model badges already applied.');
} else if (hash(current) === hash(original)) {
  writeFileSync(target, patched);
  console.log('Model badges applied. Refresh the DSH page. Restart dsh web only if it still serves the previous bundle.');
} else {
  console.error(`Refusing to overwrite an unrecognized client bundle. Adapt the patch to this DSH version first. Backup: ${fileURLToPath(new URL('./client.original.js', import.meta.url))}`);
  process.exitCode = 1;
}
