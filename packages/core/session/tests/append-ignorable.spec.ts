import { describe, expect, expectTypeOf, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, snapshotSessionEvent, type SessionEvent } from '@deepseek-ai/dsh-session'

const id = SessionId('append-ignorable')

describe('append ignorable metadata', () => {
  it('retains immutable ignorable metadata through snapshot and restore', () => {
    const session = Session.create(id)
    const options: { ignorable?: true } = { ignorable: true }
    const event = session.append('turn/start', { turn: 1 }, options)
    delete options.ignorable
    expectTypeOf(event).toEqualTypeOf<SessionEvent<'turn/start'>>()
    expect(event).toEqual({
      type: 'turn/start', seq: 0, time: event.time, data: { turn: 1 }, ignorable: true,
    })
    expect(Number.isFinite(event.time)).toBe(true)
    expect(Object.isFrozen(event)).toBe(true)
    const restored = Session.fromRestore(id, [snapshotSessionEvent(event)], session.header, SessionLogOffset(0), 'detached')
    expect(restored.eventAt(event.seq)).toEqual(event)
    expect(restored.eventAt(event.seq)?.ignorable).toBe(true)
  })

  it('combines ignorable metadata with required surface placement', () => {
    const session = Session.create(id)
    const message = createUserMessage({ content: [], source: { kind: 'user' } })
    const event = session.append('user/message', message, { surfaceOp: 'append', ignorable: true })
    expectTypeOf(event).toEqualTypeOf<SessionEvent<'user/message'>>()
    expect(event).toMatchObject({ type: 'user/message', data: message, surfaceOp: 'append', ignorable: true })
    expect(session.deriveMessages()).toEqual([message])
    if (false) {
      // @ts-expect-error Surface placement remains mandatory with ignorable metadata.
      session.append('user/message', message, { ignorable: true })
      // @ts-expect-error Non-surface events cannot acquire surface placement.
      session.append('turn/start', { turn: 1 }, { surfaceOp: 'append' })
      // @ts-expect-error False is not an ignorable declaration.
      session.append('turn/start', { turn: 1 }, { ignorable: false })
    }
  })

  it.each([false, null, 'true', 1, {}])('rejects malformed ignorable metadata before appending (%j)', (ignorable) => {
    const session = Session.create(id)
    expect(() => session.append('turn/start', { turn: 1 }, { ignorable } as never)).toThrow(/ignorable/)
    expect(session.snapshotEvents()).toEqual([])
  })

  it('reads the ignorable option once and omits undefined metadata', () => {
    const session = Session.create(id)
    let reads = 0
    const event = session.append('turn/start', { turn: 1 }, {
      get ignorable(): true {
        if (++reads !== 1) throw new Error('ignorable read twice')
        return true
      },
    })
    expect(event.ignorable).toBe(true)
    expect(reads).toBe(1)
    expect(session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }, {})).not.toHaveProperty('ignorable')
  })
})
