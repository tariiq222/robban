// Pure telemetry replay: only event data is used. Times and durations are milliseconds.
const timestamp = time => typeof time === 'number' && Number.isFinite(time) ? time : Date.parse(time);
const unionDuration = intervals => {
  const sorted = intervals.filter(([a, b]) => b >= a).sort((a, b) => a[0] - b[0]);
  let total = 0, start, end;
  for (const [a, b] of sorted) {
    if (start === undefined) { start = a; end = b; }
    else if (a <= end) end = Math.max(end, b);
    else { total += end - start; start = a; end = b; }
  }
  return total + (start === undefined ? 0 : end - start);
};
export function flowTiming(events) {
  const runs = new Map();
  for (const event of events || []) {
    if (!['auto-recipe/run-start', 'auto-recipe/agent-start', 'auto-recipe/agent-end', 'auto-recipe/run-end'].includes(event?.type)) continue;
    const data = event.data;
    const time = timestamp(event.time);
    if (!data?.runId || !Number.isFinite(time)) continue;
    if (!runs.has(data.runId)) runs.set(data.runId, { runId: data.runId, agents: new Map(), first: time, last: time });
    const run = runs.get(data.runId);
    run.first = Math.min(run.first, time); run.last = Math.max(run.last, time);
    if (event.type === 'auto-recipe/run-start') { run.start = time; run.recipe = data.recipe; }
    if (event.type === 'auto-recipe/run-end') { run.end = time; run.status = data.status; }
    if (event.type === 'auto-recipe/agent-start' && data.seq !== undefined && !run.agents.has(data.seq)) {
      run.agents.set(data.seq, { ...data, start: time });
    }
    if (event.type === 'auto-recipe/agent-end' && !data.annotate) {
      const agent = run.agents.get(data.seq);
      if (agent && agent.end === undefined) agent.end = Math.max(agent.start, time);
    }
  }
  return [...runs.values()].map(run => {
    const agents = [...run.agents.values()];
    const complete = agents.filter(a => a.end !== undefined);
    const stages = new Map(), roleModels = new Map();
    for (const agent of agents) {
      const stage = agent.phase || 'unknown';
      const role = agent.role || agent.label?.replace(/\s*#\d+$/, '') || 'unknown';
      const provider = agent.provider || 'unknown', model = agent.model || 'unknown';
      const key = JSON.stringify([role, provider, model]);
      if (!stages.has(stage)) stages.set(stage, { stage, durationMs: 0, agentCount: 0, intervals: [] });
      if (!roleModels.has(key)) roleModels.set(key, { role, provider, model, durationMs: 0, agentCount: 0 });
      const duration = agent.end === undefined ? 0 : agent.end - agent.start;
      stages.get(stage).agentCount++; stages.get(stage).durationMs += duration;
      roleModels.get(key).agentCount++; roleModels.get(key).durationMs += duration;
      if (agent.end !== undefined) stages.get(stage).intervals.push([agent.start, agent.end]);
    }
    // Sequential steps sum; concurrent steps contribute their elapsed span only once.
    // Events lack dependency edges, so this is the observed active-time critical path,
    // not a speculative DAG reconstruction. Idle/coordination gaps remain wall time.
    return {
      runId: run.runId, recipe: run.recipe || '', status: run.status || 'incomplete',
      wallClockMs: Math.max(0, (run.end ?? run.last) - (run.start ?? run.first)),
      agentCount: agents.length, incompleteAgents: agents.length - complete.length,
      agentDurationMs: complete.reduce((sum, a) => sum + a.end - a.start, 0),
      criticalPathMs: unionDuration(complete.map(a => [a.start, a.end])),
      stages: [...stages.values()].map(({ intervals, ...stage }) => ({ ...stage, wallClockMs: unionDuration(intervals) })),
      roleModels: [...roleModels.values()],
    };
  });
}
