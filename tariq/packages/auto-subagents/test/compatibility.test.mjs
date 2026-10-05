import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAutoSessionSupport } from '../lib/compatibility.mjs';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
const { Session } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session'));

test('native public Session supports optional Auto events without mutating an existing session', () => {
  const existing = Session.create('untouched-compatibility-session');
  const before = existing.snapshotEvents();
  assert.doesNotThrow(() => assertAutoSessionSupport());
  assert.equal(existing.snapshotEvents(), before);
});

test('a runtime dropping ignorable fails before Auto can write live session events', () => {
  const unsupported = {
    create(id) {
      const detached = Session.create(id);
      return { append: (type, data) => detached.append(type, data) };
    },
  };
  assert.throws(() => assertAutoSessionSupport(unsupported), error => {
    assert.match(error.message, /Auto requires DSH Session.append support/);
    assert.match(error.message, /cannot safely restore Auto events/);
    assert.match(error.cause.message, /dropped the optional-event marker/);
    return true;
  });
});

test('a marker lost by detached restore is also refused without touching an event bus', () => {
  const unsupported = {
    create: id => Session.create(id),
    fromRestore(id, events, header, inheritedCount, state) {
      const modified = structuredClone(events);
      delete modified.at(-1).ignorable;
      return Session.fromRestore(id, modified, header, inheritedCount, state);
    },
  };
  assert.throws(() => assertAutoSessionSupport(unsupported), /cannot safely restore Auto events/);
});
