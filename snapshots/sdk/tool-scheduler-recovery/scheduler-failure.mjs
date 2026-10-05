/** Recover one unavailable LLM preparation per turn, then reject one tool scheduler preparation. */
export const inject = ['tools', 'agents', 'llm']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime. */
export function apply(ctx) {
  const recoveredTurns = new WeakMap()
  ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const config = await next()
    if (recoveredTurns.get(agent) === turn) return config
    try {
      await ctx.llm.prepareCall({ ...config, provider: 'snapshot-unavailable-route' }, signal)
    } catch (error) {
      if (error.code !== 'NO_ADAPTER') throw error
      recoveredTurns.set(agent, turn)
      agent.session.append('snapshot/request-prepare-recovered', { turn, step, code: error.code }, { ignorable: true })
      return config
    }
    throw new Error('Preparation recovery requires an unavailable provider route')
  })
  // Inspect the active instance's key so the fixture cannot introduce a second tools module.
  const key = Object.getOwnPropertySymbols(ctx.tools)
    .find(symbol => symbol.description === '@deepseek-ai/dsh-tools.scheduler')
  if (key === undefined) throw new Error('Scheduler failure fixture requires the active tool scheduler')
  const scheduler = ctx.tools[key]
  const prepare = scheduler.prepare
  ctx.effect(() => {
    scheduler.prepare = async input => {
      if (input.callId === 'scheduler-fail') {
        scheduler.prepare = prepare
        throw new Error('Snapshot scheduler preparation failed')
      }
      return prepare.call(scheduler, input)
    }
    return () => { scheduler.prepare = prepare }
  }, 'scheduler failure fixture')
}
