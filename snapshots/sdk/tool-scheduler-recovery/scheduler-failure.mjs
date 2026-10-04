/** Reject one scheduler preparation to exercise the terminal internal-failure path. */
export const inject = ['tools', 'agents']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime. */
export function apply(ctx) {
  const recoveredTurns = new WeakMap()
  ctx.on('agent/request', async ({ agent, turn }, next) => {
    const config = await next()
    return recoveredTurns.get(agent) === turn ? config : { ...config, provider: 'snapshot-unavailable-route' }
  })
  ctx.on('agent/request-prepare-error', async ({ agent, turn, step, provider, failure }, next) => {
    if (provider !== 'snapshot-unavailable-route') return next()
    if (recoveredTurns.get(agent) === turn) throw new Error('Preparation recovery repeated the same failed route')
    recoveredTurns.set(agent, turn)
    agent.session.append('snapshot/request-prepare-recovered', { turn, step, code: failure.code }, { ignorable: true })
    return { kind: 'retry' }
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
