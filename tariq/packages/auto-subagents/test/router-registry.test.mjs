import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { automaticRouter } from '../lib/router.mjs';

// 6b-2: the installed dsh-tool-subagent patch imports router.mjs through home/local-plugins by an
// absolute path, while preset rows and recipes import the package's own copy. When those are two
// different module INSTANCES (a copied/relocated package, a symlinked path, ...), they must still
// share ONE router per settings service, or load spreading and `verifies` silently break.
test('two separate module instances of router.mjs share one router per settings service', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ars-router-'));
  try {
    await cp(new URL('../lib/router.mjs', import.meta.url), path.join(dir, 'router.mjs'));
    const other = await import(pathToFileURL(path.join(dir, 'router.mjs')).href);
    assert.notEqual(other.automaticRouter, automaticRouter, 'precondition: a genuinely separate module instance');
    const route = { provider: 'p', model: 'm' };
    const settings = { current: () => ({ enabled: true, allowedModels: [route] }) };
    const llm = { listProviders: () => [{ id: 'p' }] };
    const mine = automaticRouter(settings, llm);
    const theirs = other.automaticRouter(settings, llm);
    assert.equal(theirs, mine, 'same router object');
    const token = theirs.reserve(route);
    assert.equal(mine.activeCount(route), 1, 'load counted by one instance is visible to the other');
    token.release();
    assert.equal(mine.activeCount(route), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the registry is keyed by the cordis original service, not the tracking proxy', () => {
  const original = { current: () => ({ enabled: true, allowedModels: [] }) };
  const proxyA = { [Symbol.for('cordis.original')]: original, current: original.current };
  const proxyB = { [Symbol.for('cordis.original')]: original, current: original.current };
  assert.equal(automaticRouter(proxyA, {}), automaticRouter(proxyB, {}));
});
