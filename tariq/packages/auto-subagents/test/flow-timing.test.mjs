import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
const module = await import('../lib/flow-timing.mjs').catch(() => null);
const event = (type, time, data) => ({ type: `auto-recipe/${type}`, time, data: { runId: 'r1', ...data } });
const events = [event('run-start', 0, { recipe: 'feature-pipeline' }),
  event('agent-start', 10, { seq: 1, label: 'setup', role: 'setup', phase: 'setup', provider: 'p', model: 'light' }),
  event('agent-end', 30, { seq: 1 }),
  event('agent-start', 30, { seq: 2, label: 'review-1 #1', role: 'r1', phase: 'code-loop', provider: 'p', model: 'strong' }),
  event('agent-start', 30, { seq: 3, label: 'validate', role: 'validate', phase: 'validate', provider: 'p', model: 'strong' }),
  event('agent-end', 60, { seq: 2 }), event('agent-end', 70, { seq: 3 }),
  event('agent-end', 90, { seq: 2, annotate: true, verdict: 'ok' }),
  event('run-end', 100, { status: 'completed' })];
test('synthetic timing separates wall clock, summed agent work and parallel critical path', () => {
  assert.ok(module, 'flow timing module is implemented');
  const original = JSON.stringify(events);
  const [run] = module.flowTiming(events);
  assert.equal(run.wallClockMs, 100);
  assert.equal(run.agentCount, 3);
  assert.equal(run.agentDurationMs, 90);
  assert.equal(run.criticalPathMs, 60);
  assert.equal(run.stages.find(s => s.stage === 'code-loop').durationMs, 30);
  assert.equal(run.roleModels.find(s => s.role === 'validate').durationMs, 40);
  assert.equal(JSON.stringify(events), original, 'pure function never mutates events');
});
test('timing isolates runs, ignores annotations, accepts ISO dates and incomplete agents', () => {
  assert.ok(module);
  const extra = [event('run-start', '2026-01-01T00:00:00Z', { runId: 'r2' }), event('agent-start', '2026-01-01T00:00:01Z', { runId: 'r2', seq: 1, phase: 'analysis', role: 'analysis' })];
  const runs = module.flowTiming([...events, ...extra, { type: 'unrelated', time: 999 }]);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].wallClockMs, 100);
  assert.equal(runs[1].agentCount, 1);
  assert.equal(runs[1].incompleteAgents, 1);
  assert.equal(runs[1].criticalPathMs, 0);
});
test('read-only CLI prints table from temporary plain JSONL', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flow-report-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'synthetic.jsonl');
  await writeFile(file, events.map(e => JSON.stringify(e)).join('\n'));
  const { stdout } = await promisify(execFile)(process.execPath, [new URL('../scripts/flow-report.mjs', import.meta.url).pathname, file]);
  assert.match(stdout, /Run.*Wall.*Critical.*Agents/);
  assert.match(stdout, /r1/);
  assert.match(stdout, /setup/);
});
