/** Latest loaded turn activity; transient text frames do not change this projection. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {
  SessionEventLikeEntry, SessionEventSource,
} from '@deepseek-ai/dsh-api-session-controller/client'

interface ToolActivity {
  readonly seq: SessionSeq
  readonly callId: SessionEvent<'tool/call'>['data']['callId']
  readonly step: number
  readonly name?: string
  readonly result: boolean
  readonly isError: boolean
}

/** Observed durable activity for the latest turn present in the loaded window. */
export interface ExecutionActivity {
  readonly turn?: number
  readonly startKnown?: boolean
  readonly step?: number
  readonly phase: 'unknown' | 'thinking' | 'tools' | 'responding' | 'completed' | 'inactive' | 'error'
  readonly time?: number
  readonly tools: readonly ToolActivity[]
}

const EMPTY: ExecutionActivity = { phase: 'unknown', tools: [] }
const caches = new WeakMap<SessionEventSource, { revision: number; value: ExecutionActivity }>()

function observedTurn(value: ExecutionActivity, turn: number): ExecutionActivity {
  return value.turn === undefined || turn > value.turn
    ? { turn, startKnown: false, phase: 'unknown', tools: [] }
    : value
}

function fold(value: ExecutionActivity, entries: readonly SessionEventLikeEntry[]): ExecutionActivity {
  let next = value
  for (const entry of entries) {
    if (entry.type === 'transient') continue
    const event = entry.event
    switch (event.type) {
      case 'turn/start':
        if (next.turn === undefined || event.data.turn >= next.turn) {
          next = { turn: event.data.turn, startKnown: true, phase: 'thinking', time: event.time, tools: [] }
        }
        break
      case 'step/start':
        next = observedTurn(next, event.data.turn)
        if (next.turn === event.data.turn) next = { ...next, step: event.data.step, phase: 'thinking', time: event.time }
        break
      case 'tool/call':
        next = observedTurn(next, event.data.turn)
        if (next.turn === event.data.turn) next = {
          ...next, step: event.data.step, phase: 'tools', time: event.time,
          tools: [...next.tools, {
            seq: event.seq, step: event.data.step, name: event.data.name,
            callId: event.data.callId, result: false, isError: false,
          }],
        }
        break
      case 'tool/result': {
        next = observedTurn(next, event.data.turn)
        if (next.turn !== event.data.turn) break
        const callId = event.data.message.toolCallId
        const isError = event.data.message.isError === true
        const matched = next.tools.some(tool => tool.callId === callId)
        next = {
          ...next, step: event.data.step, time: event.time,
          tools: matched
            ? next.tools.map(tool => tool.callId === callId ? { ...tool, result: true, isError } : tool)
            : [...next.tools, { seq: event.seq, step: event.data.step, callId, result: true, isError }],
        }
        break
      }
      case 'assistant/message':
        next = observedTurn(next, event.data.turn)
        if (next.turn === event.data.turn) next = { ...next, step: event.data.step, phase: 'responding', time: event.time }
        break
      case 'turn/end':
        next = observedTurn(next, event.data.turn)
        if (next.turn === event.data.turn) next = {
          ...next,
          phase: event.data.reason.kind === 'completed' ? 'completed' : event.data.reason.kind === 'error' ? 'error' : 'inactive',
          time: event.time,
        }
        break
      default:
        // Merge-extensible Session events without execution presentation do not change activity.
        break
    }
  }
  return next
}

/**
 * Read stable execution activity, folding durable deltas and ignoring live text chunks.
 * @param source - currently retained Session event source, when available.
 * @returns latest turn observed in the loaded event window; absent history remains unknown.
 */
export function executionActivity(source: SessionEventSource | undefined): ExecutionActivity {
  if (source === undefined) return EMPTY
  const window = source.getSnapshot()
  const previous = caches.get(source)
  if (previous?.revision === window.revision) return previous.value
  let value: ExecutionActivity
  if (previous === undefined || previous.revision + 1 !== window.revision
    || window.change.kind === 'replace' || window.change.kind === 'prepend') {
    value = fold(EMPTY, window.entries)
  } else if (window.change.kind === 'append') {
    value = fold(previous.value, window.change.entries)
  } else {
    value = window.change.entry === undefined ? previous.value : fold(previous.value, [window.change.entry])
  }
  caches.set(source, { revision: window.revision, value })
  return value
}

/**
 * Expose stable derived activity to the renderer's private hook binding.
 * @param source - retained Session event source; absence keeps an unknown snapshot.
 * @returns a React-free observable that publishes only when durable activity changes.
 */
export function createExecutionActivitySource(source: SessionEventSource | undefined): HostObservable<ExecutionActivity> {
  return {
    getSnapshot: () => executionActivity(source),
    subscribe(listener) {
      if (source === undefined) return () => {}
      let previous = executionActivity(source)
      return source.subscribe(() => {
        const next = executionActivity(source)
        if (next === previous) return
        previous = next
        listener()
      })
    },
  }
}
