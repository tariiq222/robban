/** Verify Auto against unmodified upstream source in an isolated archive, not patched root artifacts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPristineUpstream, PRISTINE_UPSTREAM_REFERENCE } from './helpers/pristine-upstream.mjs';

test('pristine upstream source resolves and restores its native Session without local core extensions', { timeout: 120000 }, async () => {
  const result = await runPristineUpstream({ probe: new URL('./helpers/pristine-upstream-probe.mjs', import.meta.url) });
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.reference, PRISTINE_UPSTREAM_REFERENCE);
  assert.equal(report.revision, result.revision);
  assert.match(report.revision, /^[a-f0-9]{40,64}$/);
  assert.equal(report.pristineSource, true);
  assert.equal(report.nativeRestore, true);
  assert.equal(report.sourceModules, 9);
  assert.equal(report.stockSessionSupported, false);
  assert.equal(report.fullAutoHostRejected, true);
  assert.ok(report.resolvedWorkspaceModules.includes('@deepseek-ai/dsh-agent-loop'));
  assert.deepEqual(report.preparation.map(({ scenario, prepared }) => ({ scenario, prepared })), [
    { scenario: 'managed', prepared: ['a','b'] }, { scenario: 'unmanaged', prepared: ['a'] },
    { scenario: 'exhausted', prepared: ['a','b'] }, { scenario: 'nonavailability', prepared: ['a'] },
    { scenario: 'missing-adapter', prepared: ['a','b'] }, { scenario: 'unmanaged-middleware', prepared: ['a'] },
  ]);
  assert.deepEqual(report.preparation[0].streamed, [{ provider: 'two', model: 'b' }]);
  assert.equal(report.preparation.at(-1).middlewareDispatches, 1);
});
