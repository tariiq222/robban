import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RECIPES_DIR, runtimeModuleUrl } from '../lib/dsh-paths.mjs';
const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(runtimeModuleUrl('@deepseek-ai/dsh-tools'));
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const recipeDir = path.join(RECIPES_DIR, 'code-audit');
const scope = () => ({ files: ['src/a.js', 'src/b.js'], summary: 'Bounded requested area', complete: true, limitations: [] });
const scan = findings => ({ findings, coverage: ['src/a.js', 'src/b.js'], complete: true, limitations: [] });
const finding = (id = 'one', severity = 'high', file = 'src/a.js', line = 2) => ({ id, severity, file, line, title: 'Unchecked input', evidence: 'Input flows to unsafe operation', recommendation: 'Validate input', confidence: 0.8 });
const verify = resolutions => ({ resolutions, coverage: ['src/a.js', 'src/b.js'], complete: true, limitations: [] });
const resolution = (id = 'F1', status = 'verified') => ({ id, status, reason: 'Read source and checked the evidence', evidence: 'src/a.js:2 input reaches operation', confidence: 0.9 });
async function run(overrides = {}, args = {}) {
  const source = await readFile(path.join(recipeDir, 'script.js'), 'utf8');
  const execute = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', source);
  const calls = [], phases = [], launches = [];
  const defaults = { scope: scope(), 'scan-security': scan([]), 'scan-correctness': scan([]), verify: verify([]) };
  const agent = async (prompt, opts) => {
    assert.deepEqual(Object.keys(opts).sort(), ['label', 'phase', 'schema']);
    assertObjectJsonSchema(opts.schema);
    calls.push({ prompt, ...opts });
    const v = Object.hasOwn(overrides, opts.label) ? overrides[opts.label] : defaults[opts.label];
    const value = typeof v === 'function' ? await v(prompt, opts, calls) : v;
    if (value !== null && value !== undefined) {
      // Fake hooks deliberately allow malformed data: recipe itself must fail closed,
      // even if an alternate provider bypasses the engine validator.
      opts.violations = validateJsonSchemaValue(opts.schema, value);
    }
    return structuredClone(value);
  };
  const parallel = hooks => { launches.push(hooks.length); return Promise.all(hooks.map(h => Promise.resolve().then(h).catch(() => null))); };
  return { result: await execute(agent, parallel, p => phases.push(p), () => {}, { task: 'Audit source', repo: '/repo', ...args }), calls, phases, launches };
}

test('saved code-audit metadata uses a medium scope role, strong scan/check roles and three declared phases', async () => {
  const meta = JSON.parse(await readFile(path.join(recipeDir, 'meta.json'), 'utf8'));
  assert.equal(meta.name, 'code-audit');
  assert.deepEqual(meta.roles, { 'audit-scope': { tier: 'medium', readOnlyRetry: true }, 'audit-scanner': { tier: 'strong', readOnlyRetry: true }, 'audit-checker': { tier: 'strong', readOnlyRetry: true } });
  assert.equal(meta.phases.length, 3);
});
test('actual recipe returns source-only empty report, never certifies code clean', async () => {
  const { result, launches, phases } = await run();
  assert.equal(result.status, 'completed'); assert.deepEqual(result.findings, []); assert.deepEqual(result.dismissed, []);
  assert.deepEqual(result.changedPaths, []); assert.equal(result.coverage.complete, true);
  assert.match(result.summary, /not.*clean/i); assert.deepEqual(launches, [2]); assert.deepEqual(phases, ['scope', 'scans', 'verify']);
});
test('private marker enforces readonly custom roles without unsupported options or canonical reviewer', async () => {
  const { calls } = await run({}, { routingToken: 'private-token' });
  for (const call of calls) {
    const first = call.prompt.split('\n')[0]; assert.ok(first.startsWith('__AUTO_RECIPE_ROLE__'));
    const marker = JSON.parse(first.slice('__AUTO_RECIPE_ROLE__'.length));
    assert.equal(marker.token, 'private-token'); assert.equal(marker.readOnly, true);
    assert.equal(marker.role, call.label === 'verify' ? 'audit-checker' : call.label === 'scope' ? 'audit-scope' : 'audit-scanner');
    assert.ok(Number.isSafeInteger(marker.timeoutMs) && marker.timeoutMs > 0);
  }
});
test('two source scans start together before either settles', async () => {
  let pending = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const both = async () => { pending++; if (pending === 2) release(); await gate; return scan([]); };
  const { result } = await run({ 'scan-security': both, 'scan-correctness': both });
  assert.equal(pending, 2); assert.equal(result.status, 'completed');
});
test('deterministic report ranks verified findings by severity and retains high findings with evidence', async () => {
  const a = finding('a', 'low'), b = { ...finding('b', 'blocker', 'src/b.js', 5), title: 'Data loss' };
  const { result } = await run({ 'scan-security': scan([a]), 'scan-correctness': scan([b]), verify: verify([resolution('F1'), resolution('F2')]) });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.findings.map(f => f.severity), ['blocker', 'low']);
  assert.ok(result.findings.every(f => f.verified === true && f.confidence === 0.9));
});
test('duplicate local ids do not erase different findings; exact duplicates merge source evidence safely', async () => {
  const a = finding('same'), b = { ...finding('same', 'medium', 'src/b.js', 3), title: 'Different bug' };
  const { result } = await run({ 'scan-security': scan([a]), 'scan-correctness': scan([{ ...a, severity: 'low' }, b]), verify: verify([resolution('F1'), resolution('F2')]) });
  assert.equal(result.findings.length, 2); assert.equal(result.findings[0].severity, 'high'); assert.equal(result.findings[0].sources.length, 2);
});
test('dismissed high findings stay visible with explicit evidence and reason', async () => {
  const { result } = await run({ 'scan-security': scan([finding()]), verify: verify([resolution('F1', 'dismissed')]) });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.findings, []); assert.equal(result.dismissed.length, 1);
  assert.equal(result.dismissed[0].severity, 'high'); assert.ok(result.dismissed[0].reason && result.dismissed[0].verificationEvidence);
});
for (const label of ['scope', 'scan-security', 'scan-correctness', 'verify']) {
  for (const value of [null, { nonsense: true }]) test(`fail closed on ${label} ${value === null ? 'null' : 'malformed'}`, async () => {
    const { result } = await run({ [label]: value }); assert.equal(result.status, 'completed_with_failures'); assert.equal(result.coverage.complete, false); assert.ok(result.limitations.length);
  });
}
for (const resolutions of [[], [resolution('F1'), resolution('F1')], [resolution('unknown')], [{ ...resolution(), reason: '' }], [{ ...resolution(), confidence: 2 }]]) {
  test('verifier must resolve every known identity exactly once: ' + JSON.stringify(resolutions), async () => {
    const { result } = await run({ 'scan-security': scan([finding()]), verify: verify(resolutions) });
    assert.equal(result.status, 'completed_with_failures'); assert.equal(result.findings.length, 1); assert.equal(result.findings[0].verified, false); assert.deepEqual(result.dismissed, []);
  });
}
test('explicit unknown verification remains a partial report with original finding preserved', async () => {
  const { result } = await run({ 'scan-security': scan([finding()]), verify: verify([resolution('F1', 'unknown')]) });
  assert.equal(result.status, 'completed_with_failures'); assert.equal(result.findings[0].status, 'unknown'); assert.equal(result.findings[0].verified, false);
});
for (const f of [{ ...finding(), file: '../outside.js' }, { ...finding(), file: '/outside.js' }, { ...finding(), file: 'src/uninspected.js' }, { ...finding(), line: 0 }, { ...finding(), line: 1.5 }, { ...finding(), evidence: '' }]) test('invalid finding reference cannot make a complete report ' + JSON.stringify(f), async () => {
  const { result } = await run({ 'scan-security': scan([f]) }); assert.equal(result.status, 'completed_with_failures'); assert.equal(result.coverage.complete, false);
});
for (const stage of ['scope', 'scan-security', 'verify']) test('incomplete ' + stage + ' cannot certify a complete audit', async () => {
  const values = { scope: scope(), 'scan-security': scan([]), verify: verify([]) };
  const { result } = await run({ [stage]: { ...values[stage], complete: false, limitations: ['Cannot inspect all requested source'] } });
  assert.equal(result.status, 'completed_with_failures');
});
test('missing scan or verification coverage is partial even with complete=true', async () => {
  for (const overrides of [{ 'scan-security': { ...scan([]), coverage: [] }, 'scan-correctness': { ...scan([]), coverage: [] } }, { verify: { ...verify([]), coverage: [] } }]) {
    const { result } = await run(overrides); assert.equal(result.status, 'completed_with_failures');
  }
});
for (const status of ['dismissed', 'verified']) test('verifier cannot ' + status + ' a finding from source it did not inspect', async () => {
  const { result } = await run({ 'scan-security': scan([finding()]), verify: { ...verify([resolution('F1', status)]), coverage: ['src/b.js'] } });
  assert.equal(result.status, 'completed_with_failures'); assert.equal(result.findings.length, 1); assert.equal(result.findings[0].verified, false); assert.deepEqual(result.dismissed, []);
});
for (const label of ['scope', 'scan-security', 'scan-correctness', 'verify']) test('child exception stays a partial report: ' + label, async () => {
  const { result } = await run({ [label]: () => { throw new Error('child failed'); } });
  assert.equal(result.status, 'completed_with_failures'); assert.ok(result.limitations.some(s => /failed/.test(s)));
});
test('all successful child objects satisfy their actual engine value schemas', async () => {
  const { result, calls } = await run({ 'scan-security': scan([finding()]), verify: verify([resolution()]) });
  assert.equal(result.status, 'completed');
  for (const call of calls) assertObjectJsonSchema(call.schema);
  assert.equal(validateJsonSchemaValue(calls[0].schema, scope()).length, 0);
  assert.equal(validateJsonSchemaValue(calls[1].schema, scan([finding()])).length, 0);
  assert.equal(validateJsonSchemaValue(calls[2].schema, scan([])).length, 0);
  assert.equal(validateJsonSchemaValue(calls[3].schema, verify([resolution()])).length, 0);
});
for (const args of [{ task: '' }, { task: ' ' }, { task: 4 }, { repo: 'relative' }, { repo: '/repo/../other' }, { repo: '' }]) test('required input validation ' + JSON.stringify(args), async () => {
  await assert.rejects(run({}, args), /task|repo/);
});
