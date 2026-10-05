import { randomUUID } from 'node:crypto';
import { runtimeModuleUrl } from './dsh-paths.mjs';
const { Session } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session'));
const UNSUPPORTED = 'Auto requires DSH Session.append support for { ignorable: true }. This DSH runtime cannot safely restore Auto events; use the compatible Session extension before enabling Auto.';

/** Check optional event persistence on a detached session before mounting Auto.
 * No live session, persistence handle or event bus is touched.
 * @param {typeof Session} SessionType Public Session implementation to inspect.
 * @returns {void} Returns when append and detached restore retain the envelope marker.
 * @throws {Error} When the runtime would write unrestorable Auto events.
 */
export function assertAutoSessionSupport(SessionType = Session) {
  try {
    const probe = SessionType.create(randomUUID());
    const appended = probe.append('auto-compat/probe', { version: 1 }, { ignorable: true });
    if (appended?.ignorable !== true) throw new Error('Session.append dropped the optional-event marker');
    const events = structuredClone(probe.snapshotEvents());
    if (events.at(-1)?.ignorable !== true) throw new Error('Session snapshot dropped the optional-event marker');
    const restored = SessionType.fromRestore(probe.id, events, structuredClone(probe.header), 0, 'detached');
    const restoredEvent = restored.snapshotEvents().find(event => event.seq === appended.seq && event.type === 'auto-compat/probe');
    if (restoredEvent?.ignorable !== true) throw new Error('Session restore dropped the optional-event marker');
  } catch (error) {
    throw new Error(UNSUPPORTED, { cause: error });
  }
}
