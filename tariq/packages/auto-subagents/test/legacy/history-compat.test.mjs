import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeModuleUrl } from '../../lib/dsh-paths.mjs';
const { Session } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session'));
const { validateStoredEvents } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session-persistence'));
const { createUserMessage } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm'));
const decoded = session => JSON.parse(JSON.stringify(session.snapshotEvents()));

test('plugin telemetry survives the real append and persistence reader boundary', () => {
  const session = Session.create('history-compat');
  for (const type of ['auto-subagent/selected', 'auto-subagent/route', 'auto-subagent/exhausted', 'auto-recipe/run-start', 'auto-recipe/agent-start', 'auto-recipe/agent-end', 'auto-recipe/status', 'auto-recipe/decision', 'auto-recipe/run-end']) {
    const data = { route: { provider: 'fixture', model: 'fixture' }, nested: ['preserved', 3] };
    const event = session.append(type, data, { ignorable: true });
    assert.doesNotThrow(() => validateStoredEvents(session.header, decoded(session)));
    assert.equal(event.ignorable, true);
    assert.deepEqual(event.data, data);
    data.nested.push('caller mutation');
    assert.deepEqual(event.data.nested, ['preserved', 3]);
  }
});

test('unmarked unknown required events remain refused', () => {
  const session = Session.create('history-required');
  const event = session.append('unknown/required', { preserved: true });
  assert.equal(Object.hasOwn(event, 'ignorable'), false);
  assert.throws(() => validateStoredEvents(session.header, decoded(session)), /unknown.*not marked ignorable/);
});

test('invalid provided ignorable markers are rejected before appending', () => {
  for (const ignorable of [false, null, 'true', 1]) {
    const session = Session.create('history-invalid');
    assert.throws(() => session.append('auto-subagent/route', {}, { ignorable }), /ignorable/);
    assert.equal(session.snapshotEvents().length, 0);
  }
});

test('canonical user surface and omitted non-surface options remain compatible', () => {
  const session = Session.create('history-surface');
  const event = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'fixture' }], source: { kind: 'plugin', plugin: 'history-test', form: 'notice', summary: 'fixture' } }), { surfaceOp: 'append' });
  assert.equal(event.surfaceOp, 'append');
  assert.equal(Object.hasOwn(event, 'ignorable'), false);
  const boundary = session.append('session/end-seed', {});
  assert.equal(Object.hasOwn(boundary, 'ignorable'), false);
  assert.doesNotThrow(() => validateStoredEvents(session.header, decoded(session)));
});
