import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeModuleUrl, runtimePackageDir } from '../lib/dsh-paths.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('host modules resolve from declared dependencies, even with an obsolete runtime override', () => {
  const previous = process.env.DSH_RUNTIME_DIR;
  process.env.DSH_RUNTIME_DIR = '/nonexistent/old-runtime';
  try {
    assert.equal(runtimeModuleUrl('@deepseek-ai/dsh-llm'), import.meta.resolve('@deepseek-ai/dsh-llm'));
    assert.equal(runtimePackageDir('@deepseek-ai/dsh-llm'), path.dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm/package.json'))));
  } finally {
    if (previous === undefined) delete process.env.DSH_RUNTIME_DIR;
    else process.env.DSH_RUNTIME_DIR = previous;
  }
});
test('internal package paths are rejected', () => {
  assert.throws(() => runtimeModuleUrl('@deepseek-ai/dsh-llm', 'lib/private.js'), /public package export/);
});
