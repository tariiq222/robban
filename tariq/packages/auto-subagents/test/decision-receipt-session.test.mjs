// Recorded by the native AgentLoop with a keyless adapter and fixture question tool.
// The first result contains an unasked answer; the second call actually asks that question.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
import { verifiedDecisions } from '../lib/decision-receipt.mjs';

const { Session } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session'));
const { validateStoredEvents } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session-persistence'));

test('recorded canonical Session receipts authorize only questions asked by the matching call after reload', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/decision-receipt.session.json', import.meta.url), 'utf8'));
  const original = JSON.stringify(fixture);
  validateStoredEvents(fixture.header, fixture.events);
  const firstResult = fixture.events.find(event => event.type === 'tool/result');
  const questions = [{ id: 'a' }, { id: 'b' }];
  const restore = events => Session.fromRestore(fixture.header.id, events, fixture.header, 0, 'detached');

  const partial = restore(fixture.events.slice(0, firstResult.seq + 1));
  assert.deepEqual(verifiedDecisions(partial.snapshotEvents(), 'run-replay', [{ id: 'a' }], ['b']), { a: 'A' });
  assert.throws(() => verifiedDecisions(partial.snapshotEvents(), 'run-replay', questions), /No verified human answer for decision "b"/);

  const completed = restore(fixture.events);
  assert.deepEqual(verifiedDecisions(completed.snapshotEvents(), 'run-replay', questions), { a: 'A', b: 'B' });
  assert.equal(completed.deriveMessages().filter(message => message.role === 'tool').length, 2);
  assert.equal(fixture.events.at(-1).type, 'turn/end');
  assert.equal(fixture.events.at(-1).data.reason.kind, 'completed');
  assert.equal(JSON.stringify(fixture), original);
});
