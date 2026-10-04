import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(adapter = new MockAdapter([textResponse('ok')])) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('prepare-error'), { provider: 'missing', model: 'model' })
  return { ctx, agent, adapter }
}

async function send(agent: Agent) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function admitted(agent: Agent) {
  return agent.session.snapshotEvents().filter(event => ['system/message', 'user/message', 'request/header', 'request/context'].includes(event.type))
}

describe('agent/request-prepare-error', () => {
  it('reselects the route before admitting input and keeps recovery agent-scoped', async () => {
    const { ctx, agent, adapter } = await harness()
    const other = await ctx.agentLoop.create(SessionId('other'), { provider: 'mock', model: 'model' })
    let route = 'missing'
    let foreign = 0
    let preparations = 0
    let assemblies = 0
    ctx.on('system-prompt/assemble', (_assembly, _scope, next) => { assemblies++; return next() })
    agent.ctx.on('agent/request', async (_payload, next) => {
      preparations++
      return { ...await next(), provider: route }
    })
    other.ctx.on('agent/request-prepare-error', async () => { foreign++; return undefined })
    agent.ctx.on('agent/request-prepare-error', async (payload) => {
      expect(payload.agent).toBe(agent)
      expect(payload).toMatchObject({ turn: 1, step: 1, provider: 'missing', failure: { code: 'NO_ADAPTER' } })
      expect(payload.signal.aborted).toBe(false)
      expect(admitted(agent)).toEqual([])
      route = 'mock'
      return { kind: 'retry' }
    })
    await send(agent)
    expect(preparations).toBe(2)
    expect(assemblies).toBe(1)
    expect(foreign).toBe(0)
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  })

  it.each(['unhandled', 'delegate', 'terminal'] as const)('preserves native NO_ADAPTER only when %s', async (mode) => {
    const { ctx, agent } = await harness()
    let streams = 0
    ctx.on('llm/stream', async function* () { streams++; yield* textResponse('compatibility') })
    if (mode === 'delegate') ctx.on('agent/request-prepare-error', (_payload, next) => next())
    if (mode === 'terminal') ctx.on('agent/request-prepare-error', async () => undefined)
    await send(agent)
    expect(streams).toBe(mode === 'terminal' ? 0 : 1)
    if (mode === 'terminal') expect(admitted(agent)).toEqual([])
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason.kind)
      .toBe(mode === 'terminal' ? 'error' : 'completed')
  })

  it('awaits route recovery without admitting input while the listener is pending', async () => {
    const { ctx, agent, adapter } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let route = 'missing'
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: route }))
    ctx.on('agent/request-prepare-error', async () => {
      entered.resolve(undefined)
      await release.promise
      route = 'mock'
      return { kind: 'retry' }
    })
    const done = send(agent)
    await entered.promise
    try {
      expect(admitted(agent)).toEqual([])
      expect(adapter.requests).toEqual([])
    } finally {
      release.resolve(undefined)
      await done
    }
    expect(adapter.requests).toHaveLength(1)
  })

  it('keeps a thrown managed terminal failure out of compatibility streaming', async () => {
    const { ctx, agent } = await harness()
    let streams = 0
    ctx.on('llm/stream', async function* () { streams++; yield* textResponse('unused') })
    ctx.on('agent/request-prepare-error', async () => { throw new LlmError('managed routes exhausted', 'NO_ADAPTER') })
    await send(agent)
    expect(streams).toBe(0)
    expect(admitted(agent)).toEqual([])
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'error', error: { message: 'managed routes exhausted', code: 'NO_ADAPTER' } })
  })

  it('lets cancellation win over recovery without admitting input', async () => {
    const { ctx, agent, adapter } = await harness()
    ctx.on('agent/request-prepare-error', async () => {
      agent.cancel({ kind: 'user' })
      return { kind: 'retry' }
    })
    await send(agent)
    expect(admitted(agent)).toEqual([])
    expect(adapter.requests).toEqual([])
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
  })

  it('does not replay completed tools when preparing the next step fails', async () => {
    const { ctx, agent, adapter } = await harness(new MockAdapter([toolCallResponse('call', 'work', {}), textResponse('done')]))
    let route = 'mock'
    let tools = 0
    ctx.tools.register(defineContentToolFixture({ name: 'work', description: 'work', parameters: {}, execute: async () => {
      tools++
      route = 'missing'
      return [{ type: 'text', text: 'done' }]
    } }))
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: route }))
    ctx.on('agent/request-prepare-error', async ({ step }) => {
      expect(step).toBe(2)
      route = 'mock'
      return { kind: 'retry' }
    })
    await send(agent)
    expect(tools).toBe(1)
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)
  })

  it('leaves finite route attempts to recovery policy and terminates before admission', async () => {
    const { ctx, agent, adapter } = await harness()
    let attempts = 0
    ctx.on('agent/request-prepare-error', async () => {
      if (++attempts < 3) return { kind: 'retry' }
      return undefined
    })
    await send(agent)
    expect(attempts).toBe(3)
    expect(adapter.requests).toEqual([])
    expect(admitted(agent)).toEqual([])
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason.kind).toBe('error')
  })

  it.each([new LlmError('unavailable', 'UNAVAILABLE'), new Error('adapter defect')])('preserves unhandled preparation failures: %s', async (failure) => {
    const { ctx, agent, adapter } = await harness()
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'mock' }))
    vi.spyOn(adapter, 'prepareCall').mockRejectedValue(failure)
    let recoveries = 0
    ctx.on('agent/request-prepare-error', (_payload, next) => { recoveries++; return next() })
    await send(agent)
    expect(recoveries).toBe(failure instanceof LlmError ? 1 : 0)
    expect(admitted(agent)).toEqual([])
    expect(adapter.requests).toEqual([])
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason.kind).toBe('error')
  })

  it('does not offer an aborted preparation to recovery', async () => {
    const { ctx, agent, adapter } = await harness()
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'mock' }))
    vi.spyOn(adapter, 'prepareCall').mockImplementation(async () => {
      agent.cancel({ kind: 'user' })
      throw new LlmError('cancelled resolution', 'UNAVAILABLE')
    })
    let recoveries = 0
    ctx.on('agent/request-prepare-error', async () => { recoveries++; return undefined })
    await send(agent)
    expect(recoveries).toBe(0)
    expect(admitted(agent)).toEqual([])
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
  })

  it('does not offer agent/request middleware errors to preparation recovery', async () => {
    const { ctx, agent } = await harness()
    let recoveries = 0
    ctx.on('agent/request', async () => { throw new LlmError('middleware', 'MIDDLEWARE') })
    ctx.on('agent/request-prepare-error', async () => { recoveries++; return undefined })
    await send(agent)
    expect(recoveries).toBe(0)
    expect(admitted(agent)).toEqual([])
  })
})
