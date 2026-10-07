/** Execution summary and Sidebar pages derived from recorded activity and catalog membership. */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  SessionListState, SessionProjectionMap,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { Button, IconBranchOutlineRegular, SegmentedTabs, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentCatalogInjected } from './SubagentHeaderLineage.tsx'
import type { ExecutionActivity } from './execution-activity.ts'
import { NS, type SubagentKey } from './locales.ts'
import css from './ExecutionView.module.css'

/** Execution actions and renderer-owned activity hook source supplied by the slot injection. */
export interface ExecutionInjected extends SubagentCatalogInjected {
  readonly hooks: { readonly activity: HostObservable<ExecutionActivity> }
  readonly openExecution: () => void
}

type ExecutionProps = PropsRuntime<'conversation.session.header.actions'> & InjectFace<ExecutionInjected> & PropsLocale<typeof NS>
type ExecutionPanelProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<ExecutionInjected>
  & PropsLocale<typeof NS> & PropsRenderSlots<'execution.graph'>

/** Loaded Chat records supplied to execution-flow contributions without their live stores. */
export interface ExecutionGraphOwner {
  readonly nodes: readonly Pick<ChatConversationViewNode, 'kind' | 'id' | 'anchorSeq' | 'data'>[]
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Recipe-owned execution flow selected from materialized Chat nodes. */
    'execution.graph': { kind: 'chain'; scope: 'session'; owner: ExecutionGraphOwner }
  }
}
type ExecutionHooks = Pick<ExecutionProps, 'sessionId' | 'useSessions' | 'useSessionStatus' | 'useSession'> & InjectFace<ExecutionInjected>

type Status = 'running' | 'completed' | 'inactive' | 'error'
interface ExecutionNode {
  readonly id: SessionId
  readonly parent?: SessionId
  readonly address?: SubagentAddress
  readonly label: string
  readonly depth: number
  readonly status: Status
  readonly model: SessionProjectionMap['modelSelection'] | undefined
}

function useExecution(props: ExecutionHooks) {
  const state = props.useSessions(value => value)
  const statuses = props.useSessionStatus(value => value)
  const sessionRunning = props.useSession(value => value.running)
  const sessionBlank = props.useSession(value => value.blank)
  const sessionOpen = props.useSession(value => value.openState === 'open' && !value.hasMore)
  const lastAgentError = props.useSession(value => value.lastAgentError)
  const activity = props.useActivity(value => value)
  const rootRunning = statuses.get(props.sessionId)?.running ?? state.byId[props.sessionId]?.running ?? sessionRunning
  const nodes = useMemo(() => {
    const seen = new Set<SessionId>()
    const result: ExecutionNode[] = []
    function visit(id: SessionId, depth: number, parent?: SessionId, address?: SubagentAddress, label?: string): void {
      if (seen.has(id)) return
      seen.add(id)
      const summary = state.byId[id]
      const running = id === props.sessionId ? rootRunning : statuses.get(id)?.running ?? summary?.running ?? false
      const completed = id === props.sessionId
        ? activity.phase === 'completed'
        : summary?.projectionValues?.subagentTiming?.lastTurnCompleted === true
      result.push({
        id, depth,
        ...(parent === undefined ? {} : { parent }),
        ...(address === undefined ? {} : { address }),
        label: label ?? summary?.displayTitle ?? id,
        status: running ? 'running' : id === props.sessionId && (activity.phase === 'error' || lastAgentError !== null) ? 'error' : completed ? 'completed' : 'inactive',
        model: state.projectionsBySession[id]?.values.modelSelection ?? summary?.projectionValues?.modelSelection,
      })
      for (const child of state.projectionsBySession[id]?.values.subagentCatalog ?? []) {
        visit(child.id, depth + 1, id, { parentSessionId: id, childSessionId: child.id, mode: child.mode }, child.label)
      }
    }
    visit(props.sessionId, 0)
    return result
  }, [state, statuses, props.sessionId, rootRunning, activity.phase, lastAgentError])
  const childRunning = nodes.slice(1).filter(node => node.status === 'running').length
  const notStarted = sessionBlank && sessionOpen && activity.turn === undefined && nodes[0]?.model?.lastUsed == null
    && !rootRunning && childRunning === 0 && lastAgentError === null && activity.phase !== 'error'
  const phase: SubagentKey = !rootRunning && (lastAgentError !== null || activity.phase === 'error') ? 'execution.phase.error'
    : rootRunning ? activity.phase === 'tools' ? 'execution.phase.tools'
      : activity.phase === 'responding' ? 'execution.phase.responding' : 'execution.phase.thinking'
      : activity.phase === 'completed' ? 'execution.phase.completed'
        : notStarted ? 'execution.phase.notStarted' : 'execution.phase.inactive'
  return { state, nodes, activity, phase, notStarted, rootRunning, childRunning, childrenContinue: !rootRunning && childRunning > 0 }
}

function modelLabel(model: SessionProjectionMap['modelSelection'] | undefined, t: ExecutionProps['t']): string {
  const used = model?.lastUsed
  return used == null ? t('execution.modelUnknown')
    : [used.provider, used.model, used.reasoningEffort ?? t('execution.effortUnknown')].join(' · ')
}

/**
 * Render the persistent compact execution entry beside Chat.
 * @param props - session hooks, localized copy and execution actions.
 * @returns compact header action reflecting recorded activity and live child work.
 */
export function ExecutionSummary(props: ExecutionProps) {
  const value = useExecution(props)
  return <button
    type="button" className={css.summary} data-execution-summary=""
    aria-label={props.t('execution.open')} onClick={props.openExecution}
  >
    <StateDot state={value.rootRunning || value.childRunning > 0 ? 'ongoing' : value.phase === 'execution.phase.error' ? 'error' : value.activity.phase === 'completed' ? 'done' : 'idle'} />
    <span>{props.t(value.phase)}</span>
    {value.childRunning > 0 && <span className={`${css.detail} ${css.activeChildren}`}>{props.t(value.childRunning === 1 ? 'execution.activeChildren.one' : 'execution.activeChildren.other', { count: value.childRunning })}</span>}
    {value.childrenContinue && <span className={css.detail}>{props.t('execution.childrenContinue')}</span>}
  </button>
}

/**
 * Render the current execution phase and last used coordinator model above the composer.
 * @param props - session hooks, localized copy and execution actions.
 * @returns an execution card with a Sidebar navigation action.
 */
export function ExecutionCard(props: ExecutionProps) {
  const value = useExecution(props)
  return <div className={css.card} data-execution-card="">
    <div className={css.cardText}>
      <span>{props.t(value.phase)}</span>
      {value.childRunning > 0 && <span className={css.detail}>{props.t(value.childRunning === 1 ? 'execution.activeChildren.one' : 'execution.activeChildren.other', { count: value.childRunning })}</span>}
      {value.childrenContinue && <span className={css.detail}>{props.t('execution.childrenContinue')}</span>}
      {!value.notStarted && <span className={css.detail}>{props.t('execution.lastUsedModel', { model: modelLabel(value.nodes[0]?.model, props.t) })}</span>}
    </div>
    <Button variant="ghost" size="sm" onClick={props.openExecution}>{props.t('execution.open')}</Button>
  </div>
}

function CatalogNotice({ id, state, refresh, t }: {
  id: SessionId
  state: SessionListState
  refresh: ExecutionInjected['refreshProjection']
  t: ExecutionProps['t']
}) {
  const projection = state.projectionsBySession[id]
  if (projection?.state === 'error') return <div className={css.notice} role="status">
    <span>{t('execution.catalogError')}</span>
    <Button variant="ghost" size="sm" onClick={() => { refresh(id) }}>{t('retry')}</Button>
  </div>
  if (projection === undefined || projection.state === 'loading' || (projection.state === 'idle' && projection.values.subagentCatalog === undefined)) {
    return <div className={css.notice} aria-label={t('execution.catalogLoading')} aria-busy="true"><StateDot state="ongoing" /></div>
  }
  if (projection.values.subagentCatalog === undefined) return <div className={css.notice}>{t('execution.catalogUnknown')}</div>
  return null
}

/**
 * Render Activity, Agents and a contributed recipe flow inside the shared Sidebar.
 * @param props - session hooks, localized copy and catalog navigation actions.
 * @returns the execution page; unobserved branches and model routes remain explicit.
 */
export function ExecutionPanel(props: ExecutionPanelProps) {
  const value = useExecution(props)
  const chatNodes = props.useChat(chat => chat.nodes.values())
  const graphNodes = useMemo(() => chatNodes.map(({ kind, id, anchorSeq, data }) => ({ kind, id, anchorSeq, data })), [chatNodes])
  const [tab, setTab] = useState<'activity' | 'agents' | 'graph'>('activity')
  const [selected, setSelected] = useState<SessionId>()
  const id = useId()
  const panel = useRef<HTMLElement>(null)
  const focusAgents = useRef(false)
  const requested = useRef(new Set<SessionId>())
  const sessionKey = useRef(props.sessionId)
  useEffect(() => {
    if (tab !== 'agents' || !focusAgents.current) return
    focusAgents.current = false
    panel.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [tab])
  useEffect(() => {
    if (sessionKey.current !== props.sessionId) {
      sessionKey.current = props.sessionId
      requested.current.clear()
      setSelected(undefined)
    }
    for (const node of value.nodes) {
      if (requested.current.has(node.id)) continue
      requested.current.add(node.id)
      props.refreshProjection(node.id)
    }
  }, [value.nodes, props.sessionId, props.refreshProjection])
  const tabs = [
    { value: 'activity' as const, label: props.t('execution.activity'), id: `${id}-activity`, panelId: `${id}-panel` },
    { value: 'agents' as const, label: props.t('execution.agents'), id: `${id}-agents`, panelId: `${id}-panel` },
    { value: 'graph' as const, label: props.t('execution.graph'), id: `${id}-graph`, panelId: `${id}-panel` },
  ] as const
  const selectedNode = value.nodes.find(node => node.id === selected)
  function openNode(node: ExecutionNode): void {
    setSelected(node.id)
    if (node.address !== undefined) props.openChildAside(node.address)
  }
  function openMainNode(node: ExecutionNode): void {
    if (node.address !== undefined) props.openChild(node.address)
  }
  return <section ref={panel} className={css.panel} data-execution-panel="">
    <div className={css.heading}><IconBranchOutlineRegular /><span>{props.t('execution.title')}</span></div>
    <div className={css.overview}>
      <span>{props.t(value.phase)}</span>
      {value.childRunning > 0 && <span className={css.detail}>{props.t(value.childRunning === 1 ? 'execution.activeChildren.one' : 'execution.activeChildren.other', { count: value.childRunning })}</span>}
      {value.childrenContinue && <span className={css.detail}>{props.t('execution.childrenContinue')}</span>}
      {!value.notStarted && <span className={css.detail}>{props.t('execution.lastUsedModel', { model: modelLabel(value.nodes[0]?.model, props.t) })}</span>}
    </div>
    <SegmentedTabs items={tabs} value={tab} onChange={setTab} label={props.t('execution.title')} />
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} className={css.content}>
      {tab === 'activity' ? <>
        {value.activity.turn === undefined ? <div className={css.notice}>{props.t('execution.noActivity')}</div> : <>
          {value.activity.startKnown === false && <div className={css.detail}>{props.t('execution.turnStartUnknown')}</div>}
          <div className={css.detail}>{props.t('execution.turn', { turn: value.activity.turn })}{value.activity.step === undefined ? '' : ` · ${props.t('execution.step', { step: value.activity.step })}`}</div>
          {value.activity.time !== undefined && <div className={css.detail}>{props.t('execution.lastActivity', { time: new Date(value.activity.time).toISOString() })}</div>}
          <ol className={css.activities}>{value.activity.tools.map(tool => <li key={tool.seq}>
            <StateDot state={tool.isError ? 'error' : tool.result ? 'done' : value.rootRunning ? 'ongoing' : 'idle'} />
            <span>{tool.name ?? props.t('execution.toolUnknown')}</span><span className={css.detail}>{props.t('execution.step', { step: tool.step })} · {props.t(tool.isError ? 'execution.toolError' : tool.result ? 'execution.toolResult' : 'execution.toolCall')}</span>
          </li>)}</ol>
        </>}
      </> : tab === 'graph' ? props.renderSlotChain('execution.graph', { nodes: graphNodes }, {
        fallback: <div className={`${css.notice} ${css.graphNotice}`}>
          <span>{props.t('execution.noRecipe')}</span>
          <Button variant="ghost" size="sm" onClick={() => {
            focusAgents.current = true
            setTab('agents')
          }}>{props.t('execution.viewAgents')}</Button>
        </div>,
      }) : <>
        <div className={css.agents}>
          {value.nodes.map(node => <div key={node.id} className={css.branch}>
            <div className={css.node} data-execution-parent={node.parent} data-execution-child={node.id}>
              <button type="button" className={css.nodeButton} onClick={() => { openNode(node) }} aria-pressed={selected === node.id}>
                <StateDot state={node.status === 'running' ? 'ongoing' : node.status === 'completed' ? 'done' : node.status === 'error' ? 'error' : 'idle'} />
                <span>{node.id === props.sessionId ? props.t('execution.coordinator') : node.label}</span>
                <span className={css.detail}>{props.t(`execution.status.${node.status}`)}</span>
              </button>
              <div className={css.detail}><span>{props.t('execution.lastUsedLabel')}</span> <span>{modelLabel(node.model, props.t)}</span></div>
              {node.address !== undefined && <Button variant="ghost" size="sm" onClick={() => { openMainNode(node) }}>{props.t('execution.openMain')}</Button>}
              <CatalogNotice id={node.id} state={value.state} refresh={props.refreshProjection} t={props.t} />
            </div>
          </div>)}
        </div>
        {selectedNode !== undefined && <div className={css.route}>
          <span>{props.t('execution.route')}</span><span>{modelLabel(selectedNode.model, props.t)}</span>
          {selectedNode.address !== undefined && <span>{props.t('execution.parent', { parent: selectedNode.address.parentSessionId })}</span>}
        </div>}
        {value.nodes.length === 1 && value.state.projectionsBySession[props.sessionId]?.state === 'ready'
          && value.state.projectionsBySession[props.sessionId]?.values.subagentCatalog?.length === 0
          && <div className={css.notice}>{props.t('execution.noChildren')}</div>}
      </>}
      {tab === 'activity' && <CatalogNotice id={props.sessionId} state={value.state} refresh={props.refreshProjection} t={props.t} />}
    </div>
  </section>
}

/**
 * Render the execution tab chip with the existing branch icon.
 * @param props - localized execution title.
 * @returns the Sidebar tab label and icon.
 */
export function ExecutionTitle({ t }: PropsLocale<typeof NS>) {
  return <span className={css.heading}><IconBranchOutlineRegular /><span>{t('execution.title')}</span></span>
}
