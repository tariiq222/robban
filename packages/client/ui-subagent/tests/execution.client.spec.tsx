// @vitest-environment jsdom
/** Execution visibility through the plugin's registered presentation seats. */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate, sessionSnapshot, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { MutableSessionEventSource, type SessionListState, type SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { SessionSeq, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ExecutionInjected } from '../src/client/ExecutionView.tsx'
import type { ChatSnapshot, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { EMPTY_CHAT_SNAPSHOT } from '@deepseek-ai/dsh-client-ui-chat/src/client/contract/snapshot.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { executionActivity } from '../src/client/execution-activity.ts'
import { Profiler, type ComponentType } from 'react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const root = 'root' as SessionId
const worker = 'worker' as SessionId
const leaf = 'leaf' as SessionId
const callId = 'c1' as SessionEvent<'tool/call'>['data']['callId']
const contexts: Context[] = []
afterEach(async () => { cleanup(); await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
const summary = (id: SessionId, running = false): SessionSummary => ({
  id, displayTitle: id, running, blank: false, updatedAt: 0, retainedBy: {},
})
const route = { provider: 'observed-provider', model: 'observed-model', reasoningEffort: 'high' }
type ExecutionSeat = 'conversation.session.header.actions' | 'conversation.input.dock' | 'sidebar.right.pane.tab'

function isExecutionInjection(value: Record<string, unknown>): value is Record<string, unknown> & ExecutionInjected {
  const hooks = value.hooks
  if (typeof hooks !== 'object' || hooks === null || !('activity' in hooks)) return false
  const activity = hooks.activity
  return typeof activity === 'object' && activity !== null
    && 'getSnapshot' in activity && typeof activity.getSnapshot === 'function'
    && 'subscribe' in activity && typeof activity.subscribe === 'function'
    && ['openExecution', 'openChild', 'openChildAside', 'refreshProjection'].every(key => typeof value[key] === 'function')
}

function executionInjection(entry: StoredEntry | undefined, sessionId: SessionId): ExecutionInjected {
  if (entry?.inject === undefined) throw new Error('Execution seat has no injection')
  // StoredEntry erases positional parameters; these three seats are session-scoped.
  const injectSession = entry.inject as (sessionId: SessionId) => Record<string, unknown>
  const value = injectSession(sessionId)
  if (!isExecutionInjection(value)) throw new Error('Execution seat has incomplete activity or actions')
  return value
}

async function bench() {
  const ctx = new Context()
  contexts.push(ctx)
  const feed = new MutableSessionEventSource()
  const chat = createSnapshotStore<ChatSnapshot>(EMPTY_CHAT_SNAPSHOT)
  const graphOwners: object[] = []
  const state = createSnapshotStore<SessionListState>({ ids: [root, worker, leaf], phase: 'ready', byId: {
    [root]: { ...summary(root), projectionValues: { modelSelection: { lastUsed: route, next: { ...route, model: 'next-model' } } } },
    [worker]: summary(worker, true),
    [leaf]: { ...summary(leaf), projectionValues: { subagentTiming: { settledMs: 1, lastTurnCompleted: true } } },
  }, projectionsBySession: {
    [root]: { state: 'ready', error: null, values: { subagentCatalog: [{ id: worker, mode: 'continuable', label: 'Worker', createdAt: 0 }] } },
    [worker]: { state: 'ready', error: null, values: { subagentCatalog: [{ id: leaf, mode: 'one-shot', label: 'Leaf', createdAt: 0 }] } },
    [leaf]: { state: 'ready', error: null, values: { subagentCatalog: [] } },
  } })
  const calls: { method: string; args: unknown[] }[] = []
  const statuses = createSnapshotStore<Map<SessionId, { running: boolean }>>(new Map())
  const session = createSnapshotStore(sessionSnapshot(root))
  ctx.provide('sessions', { list: state, binding: () => ({ eventSource: feed }), refreshProjections: (id: SessionId) => { calls.push({ method: 'refresh', args: [id] }); return Promise.resolve() } } as never)
  ctx.provide('uiWorkspace', { openSession: (address: unknown) => { calls.push({ method: 'open', args: [address] }) } } as never)
  ctx.provide('sidebarRight', { openTab: (kind: string) => { calls.push({ method: 'tab', args: [kind] }) }, openResource: (address: string) => { calls.push({ method: 'aside', args: [address] }) } } as never)
  ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx))
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: {
    'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
    'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    'conversation.input.dock': { kind: 'list', scope: 'session' },
    'conversation.composer': { kind: 'chain', scope: 'session' },
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
    'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
  } } as never, () => null)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const fork = ctx.plugin({ inject: [...inject], apply })
  await fork.await()
  const useChat = bindSnapshotSelector(chat)
  const renderSlotChain: PropsRenderSlots<'execution.graph'>['renderSlotChain'] = (_name, owner, options) => {
    graphOwners.push(owner)
    return options?.fallback
  }
  const useSessions = bindSnapshotSelector(state)
  const useSessionStatus = bindSnapshotSelector(statuses)
  const useSession = bindSnapshotSelector(session)
  function seat(name: ExecutionSeat, key: string) {
    const entry = ctx.slots.entries(name).find(entry => entry.options.id === key || ('key' in entry.options && entry.options.key === key))
    expect(entry, `missing execution seat ${name}:${key}`).toBeDefined()
    const Component = entry!.component as ComponentType<Record<string, unknown>>
    const injected = executionInjection(entry, root)
    const { hooks, ...callbacks } = injected
    const useActivity = bindSnapshotSelector(hooks.activity)
    return <Component {...callbacks} useActivity={useActivity} sessionId={root} t={makeTranslate(en)}
      useSessions={useSessions} useSessionStatus={useSessionStatus} useSession={useSession}
      useChat={useChat} renderSlotChain={renderSlotChain} />
  }
  return { ctx, fork, seat, state, statuses, feed, calls, session, chat, graphOwners }
}

const executionId = '@deepseek-ai/dsh-client-ui-subagent/execution'

describe('execution presentation', () => {
  it('recipe flow delegates materialized chat updates and keeps no-recipe catalog details in Agents', async () => {
    const b = await bench()
    render(b.seat('sidebar.right.pane.tab', executionId))
    fireEvent.click(screen.getByRole('tab', { name: 'Graph' }))
    expect(screen.getByText('No recorded recipe flow in the loaded history. View Agents for session details.')).toBeTruthy()
    expect(b.graphOwners.at(-1)).toEqual({ nodes: [] })
    const node: ChatConversationViewNode = {
      key: 'recipe-run', kind: 'auto-recipe-run', id: 'run', anchorSeq: 20, target: 'chat',
      location: { kind: 'session' }, visibility: 'visible', data: { status: 'running' },
    }
    act(() => { b.chat.set({ ...EMPTY_CHAT_SNAPSHOT, nodes: { ...EMPTY_CHAT_SNAPSHOT.nodes, values: () => [node] } }) })
    expect(b.graphOwners.at(-1)).toEqual({ nodes: [{ kind: node.kind, id: node.id, anchorSeq: node.anchorSeq, data: node.data }] })
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    expect(screen.getByRole('button', { name: /Leaf/ })).toBeTruthy()
    b.ctx.slots.register({ name: 'execution.graph', select: () => true }, () => null)
    expect(b.ctx.slots.entries('execution.graph')).toHaveLength(1)
    await b.fork.dispose()
    expect(b.ctx.slots.entries('execution.graph')).toHaveLength(0)
  })

  it('registers persistent summary, execution card, page and icon, and disposes them', async () => {
    const b = await bench()
    render(<>{b.seat('conversation.session.header.actions', 'execution-summary')}{b.seat('conversation.input.dock', 'execution-card')}</>)
    expect(document.querySelector('[data-execution-summary]')).not.toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'View execution' })[0]!)
    expect(b.calls).toContainEqual({ method: 'tab', args: ['execution'] })
    expect(b.ctx.sidebarRightTabs.get('execution')?.patterns).toBeUndefined()
    expect(b.ctx.slots.entries('sidebar.right.pane.tab.title').some(e => 'key' in e.options && e.options.key === executionId)).toBe(true)
    await b.fork.dispose()
    expect(b.ctx.sidebarRightTabs.get('execution')).toBeUndefined()
    expect(b.ctx.slots.entries('conversation.session.header.actions').some(e => e.options.id === 'execution-summary')).toBe(false)
  })

  it('keeps child work visible after the coordinator stops and uses observed model rather than next', async () => {
    const b = await bench()
    render(b.seat('conversation.input.dock', 'execution-card'))
    expect(screen.getByText(/child work continues/i)).toBeTruthy()
    expect(screen.getByText(/observed-provider.*observed-model.*high/)).toBeTruthy()
    expect(screen.queryByText(/next-model/)).toBeNull()
  })

  it('navigates nested agent nodes using their direct parent and distinguishes completion from inactivity', async () => {
    const b = await bench()
    render(b.seat('sidebar.right.pane.tab', executionId))
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    const agents = screen.getByRole('tabpanel')
    expect(within(agents).getByText('Coordinator')).toBeTruthy()
    expect(agents.querySelector('[data-execution-parent="worker"][data-execution-child="leaf"]')).not.toBeNull()
    fireEvent.click(within(agents).getByRole('button', { name: /Leaf/ }))
    expect(b.calls).toContainEqual({ method: 'aside', args: ['dsh-resource://subagentchat/session/leaf?parent=worker&mode=one-shot'] })
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    expect(screen.getByText('Completed')).toBeTruthy()
    expect(screen.getAllByText('Model unknown').length).toBeGreaterThan(0)
    act(() => { b.statuses.set(new Map([[worker, { running: false }]])) })
    expect(screen.getAllByText('Inactive').length).toBeGreaterThan(0)
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.getByText('Completed')).toBeTruthy()
  })

  it('shows catalog loading and errors with retained membership, retry and a solo coordinator', async () => {
    const b = await bench()
    act(() => { const state = b.state.getSnapshot(); b.state.set({ ...state, projectionsBySession: { [root]: { state: 'loading', error: null, values: {} } } }) })
    render(b.seat('sidebar.right.pane.tab', executionId))
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    expect(screen.getByText('Coordinator')).toBeTruthy()
    expect(screen.getByLabelText('Loading child sessions')).toBeTruthy()
    expect(b.calls).toContainEqual({ method: 'refresh', args: [root] })
    act(() => { const state = b.state.getSnapshot(); b.state.set({ ...state, projectionsBySession: { [root]: { state: 'error', error: null, values: { subagentCatalog: [{ id: worker, mode: 'unknown', createdAt: 0 }] } } } }) })
    expect(screen.getByText('Unable to load child sessions')).toBeTruthy()
    expect(screen.getByRole('button', { name: /worker/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(b.calls.filter(call => call.method === 'refresh' && call.args[0] === root).length).toBeGreaterThan(1)
    act(() => { const state = b.state.getSnapshot(); b.state.set({ ...state, projectionsBySession: { [root]: { state: 'ready', error: null, values: { subagentCatalog: [] } } } }) })
    expect(screen.getByText('No child sessions')).toBeTruthy()
  })

  it('keeps a recorded coordinator error separate from continuing child work and names the model as last used', async () => {
    const b = await bench()
    b.session.set({ ...b.session.getSnapshot(), lastAgentError: 'request failed' })
    render(b.seat('conversation.input.dock', 'execution-card'))
    expect(screen.getByText('Execution stopped with an error')).toBeTruthy()
    expect(screen.getByText(/child work continues/i)).toBeTruthy()
    expect(screen.getByText(/Last used model: observed-provider/)).toBeTruthy()
  })

  it('does not use a next-request selection when the recorded model is missing', async () => {
    const b = await bench()
    const state = b.state.getSnapshot()
    b.state.set({ ...state, byId: {
      ...state.byId,
      [root]: { ...state.byId[root]!, projectionValues: { modelSelection: { lastUsed: null, next: route } } },
    } })
    render(b.seat('conversation.input.dock', 'execution-card'))
    expect(screen.getByText(/Model unknown/)).toBeTruthy()
    expect(screen.queryByText(/observed-model/)).toBeNull()
  })

  it('preserves a durable coordinator error even when child work continues', async () => {
    const b = await bench()
    b.feed.replace([
      { type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 10, data: { turn: 1 } } },
      { type: 'event', event: { type: 'turn/end', seq: SessionSeq(2), time: 11, data: { turn: 1, reason: { kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } } } } },
    ] satisfies SessionEventLikeEntry[], false)
    render(b.seat('conversation.input.dock', 'execution-card'))
    expect(screen.getByText('Execution stopped with an error')).toBeTruthy()
    expect(screen.getByText(/child work continues/i)).toBeTruthy()
  })

  it('pairs successful and failed tool results by toolCallId without optional source references', async () => {
    const b = await bench()
    b.feed.replace([
      { type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } },
      { type: 'event', event: { type: 'tool/call', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1, callId, name: 'read_file', arguments: '{}' } } },
    ] satisfies SessionEventLikeEntry[], false)
    render(b.seat('sidebar.right.pane.tab', executionId))
    act(() => { b.feed.append({ type: 'event', event: { type: 'tool/result', seq: SessionSeq(3), time: 3,
      surfaceOp: 'append', data: { turn: 1, step: 1, message: {
        id: 'result' as SessionEvent<'tool/result'>['data']['message']['id'], role: 'tool', source: { kind: 'tool', callId },
        toolCallId: callId, content: [], isError: false,
      } },
    } }) })
    expect(screen.getByText(/Result received/)).toBeTruthy()
    act(() => { b.feed.replace([
      { type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } },
      { type: 'event', event: { type: 'tool/call', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1, callId, name: 'read_file', arguments: '{}' } } },
      { type: 'event', event: { type: 'tool/result', seq: SessionSeq(3), time: 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: {
        id: 'result' as SessionEvent<'tool/result'>['data']['message']['id'], role: 'tool', source: { kind: 'tool', callId },
        toolCallId: callId, content: [], isError: true,
      } } } },
    ] satisfies SessionEventLikeEntry[], false) })
    expect(screen.getByText(/Tool error/)).toBeTruthy()
    expect(screen.getByText('read_file').parentElement?.querySelector('[data-state="error"]')).not.toBeNull()
  })

  it('ignores transient frames and resets latest-turn activity on replacement or older-page prepend', async () => {
    const b = await bench()
    b.feed.replace([
      { type: 'event', event: { type: 'turn/start', seq: SessionSeq(5), time: 5, data: { turn: 2 } } },
      { type: 'event', event: { type: 'turn/end', seq: SessionSeq(6), time: 6, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } } },
    ] satisfies SessionEventLikeEntry[], true)
    const previous = executionActivity(b.feed)
    expect(previous.phase).toBe('inactive')
    b.feed.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 7, time: 7, data: {
      attemptId: 'attempt' as Extract<SessionEventLikeEntry, { type: 'transient' }>['event']['data']['attemptId'],
      turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'one streamed token' },
    } } })
    expect(executionActivity(b.feed)).toBe(previous)
    b.feed.prepend([
      { type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } },
      { type: 'event', event: { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } } },
    ] satisfies SessionEventLikeEntry[], false)
    expect(executionActivity(b.feed).turn).toBe(2)
    expect(executionActivity(b.feed).phase).toBe('inactive')
    b.feed.replace([], true)
    expect(executionActivity(b.feed)).toEqual({ phase: 'unknown', tools: [] })
  })

  it('provides activity through the framework hooks compartment', async () => {
    const b = await bench()
    const entry = b.ctx.slots.entries('conversation.session.header.actions').find(entry => entry.options.id === 'execution-summary')!
    const injected = executionInjection(entry, root)
    expect(injected).toHaveProperty('hooks.activity')
    expect(injected).not.toHaveProperty('eventSource')
  })

  it('does not reconcile Agents for transient frames and unchanged session scalars', async () => {
    const b = await bench()
    let commits = 0
    render(<Profiler id="execution" onRender={() => { commits += 1 }}>{b.seat('sidebar.right.pane.tab', executionId)}</Profiler>)
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    const before = commits
    act(() => {
      b.feed.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 7, time: 7, data: {
        attemptId: 'attempt' as Extract<SessionEventLikeEntry, { type: 'transient' }>['event']['data']['attemptId'],
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'one streamed token' },
      } } })
      b.session.set({ ...b.session.getSnapshot() })
    })
    expect(commits).toBe(before)
    expect(screen.getByRole('button', { name: /Leaf/ })).toBeTruthy()
    act(() => { b.session.set({ ...b.session.getSnapshot(), lastAgentError: 'request failed' }) })
    expect(screen.getByText('Execution stopped with an error')).toBeTruthy()
    expect(commits).toBeGreaterThan(before)
  })

  it('renders observed tools and an error from a tail window whose turn start is not loaded', async () => {
    const b = await bench()
    b.feed.replace([
      { type: 'event', event: { type: 'step/start', seq: SessionSeq(502), time: 502, data: { turn: 1, step: 251 } } },
      { type: 'event', event: { type: 'tool/call', seq: SessionSeq(503), time: 503, data: { turn: 1, step: 251, callId, name: 'tail_tool', arguments: '{}' } } },
      { type: 'event', event: { type: 'tool/result', seq: SessionSeq(504), time: 504, surfaceOp: 'append', data: { turn: 1, step: 251, message: {
        id: 'result' as SessionEvent<'tool/result'>['data']['message']['id'], role: 'tool', source: { kind: 'tool', callId },
        toolCallId: callId, content: [], isError: true,
      } } } },
      { type: 'event', event: { type: 'turn/end', seq: SessionSeq(505), time: 505, data: { turn: 1, reason: { kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } } } } },
    ] satisfies SessionEventLikeEntry[], true)
    render(b.seat('sidebar.right.pane.tab', executionId))
    expect(screen.getByText('tail_tool')).toBeTruthy()
    expect(screen.getByText('Execution stopped with an error')).toBeTruthy()
    expect(screen.getByText('Turn start is outside the loaded history')).toBeTruthy()
    expect(screen.getByText(/Tool error/)).toBeTruthy()
    expect(screen.queryByText('No recorded activity in the loaded history')).toBeNull()
    act(() => { b.feed.prepend([
      { type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } },
    ] satisfies SessionEventLikeEntry[], false) })
    expect(screen.queryByText('Turn start is outside the loaded history')).toBeNull()
    expect(screen.getByText('tail_tool')).toBeTruthy()
  })

  it('keeps the injected activity source stable and only notifies durable activity changes', async () => {
    const b = await bench()
    const entry = b.ctx.slots.entries('conversation.session.header.actions').find(entry => entry.options.id === 'execution-summary')!
    const injectActivity = (): ExecutionInjected => executionInjection(entry, root)
    const source = injectActivity().hooks.activity
    expect(injectActivity().hooks.activity).toBe(source)
    let notifications = 0
    const stop = source.subscribe(() => { notifications += 1 })
    b.feed.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } })
    expect(source.getSnapshot().turn).toBe(1)
    expect(notifications).toBe(1)
    const before = source.getSnapshot()
    b.feed.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 2, time: 2, data: {
      attemptId: 'attempt' as Extract<SessionEventLikeEntry, { type: 'transient' }>['event']['data']['attemptId'],
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'one streamed token' },
    } } })
    expect(source.getSnapshot()).toBe(before)
    expect(notifications).toBe(1)
    stop()
    b.feed.append({ type: 'event', event: { type: 'turn/end', seq: SessionSeq(3), time: 3, data: { turn: 1, reason: { kind: 'completed' } } } })
    expect(source.getSnapshot().phase).toBe('completed')
    expect(notifications).toBe(1)
  })

  it('shows a loaded result whose tool call and turn start are outside the window', async () => {
    const b = await bench()
    b.feed.replace([
      { type: 'event', event: { type: 'tool/result', seq: SessionSeq(504), time: 504, surfaceOp: 'append', data: { turn: 1, step: 251, message: {
        id: 'result' as SessionEvent<'tool/result'>['data']['message']['id'], role: 'tool', source: { kind: 'tool', callId },
        toolCallId: callId, content: [], isError: false,
      } } } },
      { type: 'event', event: { type: 'turn/end', seq: SessionSeq(505), time: 505, data: { turn: 1, reason: { kind: 'completed' } } } },
    ] satisfies SessionEventLikeEntry[], true)
    render(b.seat('sidebar.right.pane.tab', executionId))
    expect(screen.getByText('Unobserved tool call')).toBeTruthy()
    expect(screen.getByText(/Result received/)).toBeTruthy()
    expect(screen.getByText('Turn completed')).toBeTruthy()
    expect(screen.getByText('Turn start is outside the loaded history')).toBeTruthy()
  })

  it('renders recorded latest-turn steps, tool results and conservative missing activity', async () => {
    const b = await bench()
    b.feed.replace([
      { type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 10, data: { turn: 1 } } },
      { type: 'event', event: { type: 'step/start', seq: SessionSeq(2), time: 11, data: { turn: 1, step: 1 } } },
      { type: 'event', event: { type: 'tool/call', seq: SessionSeq(3), time: 12, data: { turn: 1, step: 1, callId, name: 'read_file', arguments: '{}' } } },
      { type: 'event', event: { type: 'turn/end', seq: SessionSeq(4), time: 13, data: { turn: 1, reason: { kind: 'completed' } } } },
    ] satisfies SessionEventLikeEntry[], false)
    render(b.seat('sidebar.right.pane.tab', executionId))
    expect(screen.getByText('read_file')).toBeTruthy()
    expect(screen.getByText('Turn completed')).toBeTruthy()
    expect(screen.getByText('Turn 1 · Step 1')).toBeTruthy()
    act(() => { b.feed.replace([], true) })
    expect(screen.getByText('No recorded activity in the loaded history')).toBeTruthy()
    expect(screen.queryByText('read_file')).toBeNull()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Activity' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Agents' }).getAttribute('aria-selected')).toBe('true')
  })
})
