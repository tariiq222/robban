// build.mjs runs before the DSH runtime packages are resolvable from this package, so the
// modules it loads must reach only node: builtins and other such local modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imports = file => [...readFileSync(file, 'utf8').matchAll(/^import\s[^'"]*['"]([^'"]+)['"]|await import\(/gm)].map(m => m[1] ?? 'dynamic import');

test('build.mjs loads no runtime package or dynamic import, directly or transitively', () => {
  const seen = new Set(), queue = [path.join(root, 'build.mjs')];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of imports(file)) {
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${path.relative(root, file)} imports ${spec}`);
      queue.push(path.resolve(path.dirname(file), spec));
    }
  }
});
