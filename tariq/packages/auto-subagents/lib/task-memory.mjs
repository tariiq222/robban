// Durable task notes are reported context, never human approval or execution proof.
import path from 'node:path';
import { runtimeModuleUrl } from './dsh-paths.mjs';
import { TaskMemoryStore, TASK_MEMORY_DIR } from './task-memory-store.mjs';
import { TaskWorkStore, projectTaskWork } from './task-work-store.mjs';
import { isDelegatedAgent } from './agent-ownership.mjs';
const { defineTool } = await import(runtimeModuleUrl('@deepseek-ai/dsh-tools'));
const stores = new WeakMap();
const workStores = new WeakMap();
export const name = 'auto-subagents-task-memory';
export const inject = ['tools', 'agents'];
const summary = ({ entries, ...task }) => ({ ...task, entryCount: entries.length });
const DISCLAIMER = 'Reported task context only: not verified human permission, execution evidence or proof of completion. A new task needs a new id; continue an existing task only with its explicit id. No title matching or workspace-wide automatic joining.';
const workView = (plan, rootGoal) => {
  if (!plan) return null;
  const projected = projectTaskWork(plan);
  const items = projected.items.map(({ id, title, goalIds, acceptance, verifyCommands, dependencies, recipe, status, readiness, blocker, evidenceMode }) => ({ id, title, goalIds, acceptance, verifyCommands, dependencies, recipe, status, readiness, ...(blocker === undefined ? {} : { blocker }), ...(evidenceMode === undefined ? {} : { evidenceMode }) }));
  const counts = Object.fromEntries(['pending', 'in_progress', 'blocked', 'completed'].map(status => [status, items.filter(item => item.status === status).length]));
  return { taskId: plan.taskId, rootGoal, revision: plan.revision, goals: plan.goals, items, ready: items.filter(item => item.readiness === 'ready').map(item => item.id), waiting: items.filter(item => item.readiness === 'waiting').map(item => item.id), goalProgress: projected.goals, counts, totalItems: items.length };
};

/** Resolve the context-owned store shared by task tools and recipe integration.
 * @param {object} ctx Plugin context.
 * @param {{memoryDir?:string}} config Durable storage configuration.
 * @returns {TaskMemoryStore} The store for this mounted context.
 */
export function getTaskMemoryStore(ctx, config = {}) {
  if (config.memoryDir !== undefined && (typeof config.memoryDir !== 'string' || !config.memoryDir.trim() || !path.isAbsolute(config.memoryDir))) throw new Error('task_memory memoryDir must be a nonempty absolute path');
  const dir = path.resolve(config.memoryDir ?? TASK_MEMORY_DIR);
  const existing = stores.get(ctx);
  if (existing) {
    if (existing.dir !== dir) throw new Error('task_memory memoryDir differs from the context-owned store');
    return existing.store;
  }
  const store = new TaskMemoryStore({ dir });
  stores.set(ctx, { dir, store });
  return store;
}

/** Resolve the work graph store using the same private directory as task notes.
 * @param {object} ctx Plugin context.
 * @param {{memoryDir?:string}} config Durable storage configuration.
 * @returns {TaskWorkStore} The store for this mounted context.
 */
export function getTaskWorkStore(ctx, config = {}) {
  getTaskMemoryStore(ctx, config);
  const dir = path.resolve(config.memoryDir ?? TASK_MEMORY_DIR);
  const existing = workStores.get(ctx);
  if (existing) return existing;
  const store = new TaskWorkStore({ dir });
  workStores.set(ctx, store);
  return store;
}

const integer = (value, min, max, name) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`task_memory ${name} must be an integer from ${min} to ${max}`);
  return value;
};

/** Register task_memory, deriving repository identity exclusively from the calling session.
 * @param {object} ctx Plugin context with tools and effects.
 * @param {{memoryDir?:string}} config Durable storage configuration.
 */
export function apply(ctx, config = {}) {
  const store = getTaskMemoryStore(ctx, config);
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'task_memory',
    description: `${DISCLAIMER} Create/list/read/append durable notes across sessions in this workspace. Define/read a work plan, block or reopen its items. Only the top-level coordinator may mutate notes or plans. Plan revisions are separate from note revisions: use read_plan before changing a plan and read before appending notes. Only run_recipe claims and settles work; no model action can start or complete an item. Append requires the last observed revision; a stale revision must be reread rather than merged as authority. Read returns newest-first pages, not the whole history.`,
    parameters: {
      action: { type: 'string', enum: ['create', 'list', 'read', 'append', 'define_plan', 'read_plan', 'block_item', 'reopen_item'], required: true },
      taskId: { type: 'string', description: 'Explicit durable task id for notes or its work plan.' },
      title: { type: 'string', description: 'Short title for a new task; never used to join an old task.' },
      goal: { type: 'string', description: 'Goal for a newly created task.' },
      expectedRevision: { type: 'integer', description: 'Required for mutations and paginated note read after the first page. Use the note revision for append, or the work revision from read_plan for plan mutations.' },
      goals: { type: 'json', description: 'define_plan subgoals [{id,description}] under the existing task goal; ids use lowercase kebab-case, maximum 20.' },
      items: { type: 'json', description: 'define_plan work packages [{id,title,description,goalIds,writePaths,readPaths?,acceptance,verifyCommands,dependencies,recipe,evidenceMode?}], maximum 20. evidenceMode source_only or runtime distinguishes source inspection from executed verification. Declare actual data-flow dependencies, not merely disjoint write scopes.' },
      itemId: { type: 'string', description: 'Explicit work item id for block_item/reopen_item, or read_plan to inspect one complete item including its scopes, description, owning attempt and prior outcome.' },
      reason: { type: 'string', description: 'Reason for blocking or reopening work; not permission to waive verification.' },
      entry: { type: 'json', description: 'Append note {kind,text,refs?}; kinds: progress, evidence, decision, blocker, next_step, run. Text at most 4000 characters; context only, never approval.' },
      limit: { type: 'integer', description: 'Page size from 1 to 20; defaults to 10.' },
      cursor: { type: 'integer', description: 'Read offset into newest-first history; use nextCursor with the same expectedRevision.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent;
      const header = agent?.session?.header;
      if (!agent || typeof header?.cwd !== 'string' || !path.isAbsolute(header.cwd)) throw new Error('task_memory requires a calling agent with an absolute workspace cwd');
      if (Object.hasOwn(args, 'repo')) throw new Error('task_memory repository is owned by the calling session, not tool arguments');
      const repo = header.cwd;
      if (agent.session.id === undefined || agent.session.id === null || String(agent.session.id).trim() === '') throw new Error('task_memory requires the calling session id');
      const sessionId = String(agent.session.id);
      if (['create', 'append', 'define_plan', 'block_item', 'reopen_item'].includes(args.action) && isDelegatedAgent(agent, ctx.agents)) throw new Error('task_memory mutations require the top-level coordinator; subagents may only read or list');
      if (args.action === 'create') return { contextWarning: DISCLAIMER, task: summary(await store.create({ repo, title: args.title, goal: args.goal, sessionId })) };
      if (['define_plan', 'read_plan', 'block_item', 'reopen_item'].includes(args.action)) {
        const work = getTaskWorkStore(ctx, config);
        const task = await store.get({ repo, taskId: args.taskId });
        const request = { repo, taskId: args.taskId, sessionId, expectedRevision: args.expectedRevision };
        let plan;
        try {
          if (args.action === 'read_plan') plan = await work.get(request);
          else {
            integer(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision');
            if (args.action === 'define_plan') plan = await work.define({ ...request, goals: args.goals, items: args.items });
            else plan = await work[args.action === 'block_item' ? 'block' : 'reopen']({ ...request, itemId: args.itemId, reason: args.reason });
          }
        } catch (error) {
          if (error?.code === 'TASK_WORK_CONFLICT') throw new Error('task_memory stale work revision: read_plan before retrying; note revision is separate from work revision', { cause: error });
          throw error;
        }
        let detail;
        if (args.action === 'read_plan' && args.itemId !== undefined) {
          const item = plan?.items.find(item => item.id === args.itemId);
          if (!item) throw new Error('task_memory work item not found; read_plan without itemId to inspect available items');
          detail = structuredClone(item);
        }
        return { contextWarning: DISCLAIMER, plan: workView(plan, task.goal), ...(detail === undefined ? {} : { detail }), observedWorkRevision: plan?.revision ?? 0, note: plan ? 'Plan states come from host-owned recipe attempts. Notes cannot mark work complete or waive verification; only run_recipe claims and settles items. Use read_plan with itemId for full scopes, description and prior outcome before choosing or reopening work.' : 'No work plan is defined for this task. Define it with expectedRevision 0; notes and work revisions are separate.' };
      }
      const limit = integer(args.limit ?? 10, 1, 20, 'limit');
      if (args.action === 'list') return { contextWarning: DISCLAIMER, tasks: await store.list({ repo, limit }), limit, note: 'Bounded task discovery; use an explicit known taskId to continue. This list does not automatically join any task.' };
      if (args.action === 'append') {
        integer(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision');
        let task;
        try { task = await store.append({ repo, taskId: args.taskId, sessionId, expectedRevision: args.expectedRevision, entry: args.entry }); }
        catch (error) {
          if (error?.code === 'TASK_MEMORY_CONFLICT') throw new Error('task_memory stale revision: reread the task before retrying; do not merge notes as permission or completion proof', { cause: error });
          throw error;
        }
        return { contextWarning: DISCLAIMER, task: summary(task), appendedEntry: task.entries.at(-1) };
      }
      if (args.action !== 'read') throw new Error('task_memory action must be create, list, read, append, define_plan, read_plan, block_item or reopen_item');
      const cursor = integer(args.cursor ?? 0, 0, Number.MAX_SAFE_INTEGER, 'cursor');
      if (cursor > 0 || args.expectedRevision !== undefined) integer(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision');
      const task = await store.get({ repo, taskId: args.taskId });
      if (!task) throw new Error('task_memory task not found in this workspace');
      if (args.expectedRevision !== undefined && task.revision !== args.expectedRevision) throw new Error('task_memory stale revision: reread from cursor 0; do not merge notes as permission or completion proof');
      if (cursor > task.entries.length) throw new Error('task_memory cursor exceeds the task history');
      const entries = task.entries.slice().reverse().slice(cursor, cursor + limit);
      const remainingEntries = task.entries.length - cursor - entries.length;
      return { contextWarning: DISCLAIMER, task: { ...task, entries }, totalEntries: task.entries.length, remainingEntries, nextCursor: remainingEntries ? cursor + entries.length : null, observedRevision: task.revision, note: 'Entries are newest first. For older entries, pass nextCursor and observedRevision as expectedRevision. Append invalidates this pagination revision.' };
    },
  })));
}
