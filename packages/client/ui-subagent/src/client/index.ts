/** Web subagent catalog, navigation, and addressed-session composer owner. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SubagentCatalogAction, SubagentHeaderLineage, type SubagentCatalogInjected } from './SubagentHeaderLineage.tsx'
import {
  SubagentReadOnlyComposer, type SubagentReadOnlyMatch,
} from './SubagentReadOnlyComposer.tsx'
import { registerSidebarChat, subagentChatAddress } from './sidebar-chat/index.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { en, NS, zh, type SubagentKey } from './locales.ts'
import { ExecutionCard, ExecutionPanel, ExecutionSummary, ExecutionTitle, type ExecutionInjected } from './ExecutionView.tsx'
import { createExecutionActivitySource } from './execution-activity.ts'
import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Subagent catalog and read-only composer copy. */
    'subagent': SubagentKey
  }
}

export type {
  SubagentCatalogActionProps, SubagentCatalogInjected, SubagentHeaderLineageProps,
} from './SubagentHeaderLineage.tsx'
export type {
  SubagentReadOnlyComposerProps, SubagentReadOnlyMatch,
} from './SubagentReadOnlyComposer.tsx'

/** Required services for subagent presentation and navigation. */
export const inject = ['sessions', 'uiWorkspace', 'slots', 'locale', 'sidebarRight']

/** Claim the composer for one-shot history or an unavailable continuation owner. */
function selectReadOnlySubagent(owner: ComposerChainProps): SubagentReadOnlyMatch | null {
  const subagent = owner.session?.subagent
  if (subagent === undefined || subagent === null) return null
  if (subagent.address.mode === 'unknown') return { reason: 'unknown' }
  if (subagent.address.mode === 'one-shot') return { reason: 'one-shot' }
  // Until a Host summary establishes parent availability, keep the normal
  // disabled composer instead of claiming that the parent is offline.
  if (subagent.parentAvailable !== false) return null
  // A RUNNING parent-offline continuable child keeps the default composer:
  // its input is disabled there, but the same primary Stop stays available so
  // the child can be interrupted. Once it stops, this takeover returns.
  return owner.session?.running === true ? null : { reason: 'parent-unavailable' }
}

/**
 * Client plugin body: register the subagent catalog and read-only composer seats.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-subagent: dictionaries')
  ctx.inject(['resources', 'sidebarRightTabs'], (scope) => {
    registerSidebarChat(scope, ctx.locale.bind(NS))
  })
  const catalogActions = (_parentSessionId: SessionId): SubagentCatalogInjected => ({
    openChild(address: SubagentAddress) {
      ctx.uiWorkspace.openSession(address)
    },
    openChildAside(address: SubagentAddress) {
      ctx.sidebarRight.openResource(subagentChatAddress(address), {
        kind: 'subagentchat',
        preferNewPane: true,
      })
    },
    refreshProjection(parentSessionId: SessionId) {
      void ctx.sessions.refreshProjections(parentSessionId)
    },
  })
  const activitySources = new WeakMap<SessionEventSource, ReturnType<typeof createExecutionActivitySource>>()
  const absentActivity = createExecutionActivitySource(undefined)
  const activitySourceOf = (source: SessionEventSource | undefined): ReturnType<typeof createExecutionActivitySource> => {
    if (source === undefined) return absentActivity
    let activity = activitySources.get(source)
    if (activity === undefined) {
      activity = createExecutionActivitySource(source)
      activitySources.set(source, activity)
    }
    return activity
  }
  const executionActions = (sessionId: SessionId): ExecutionInjected => ({
    ...catalogActions(sessionId),
    hooks: { activity: activitySourceOf(ctx.sessions.binding(sessionId)?.eventSource) },
    openExecution: () => { ctx.sidebarRight.openTab('execution') },
  })
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'execution-summary', order: -25,
    locale: NS, inject: executionActions,
  }, ExecutionSummary))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'execution-card', order: -20,
    locale: NS, inject: executionActions,
  }, ExecutionCard))
  ctx.inject(['sidebarRightTabs'], (scope) => {
    const id = '@deepseek-ai/dsh-client-ui-subagent/execution'
    const t = ctx.locale.bind(NS)
    scope.effect(() => scope.sidebarRightTabs.register({
      id, kind: 'execution', priority: 'builtin', title: () => t('execution.title'),
      guide: [{ id: 'execution', order: 30, title: () => t('execution.title'), icon: IconBranchOutlineRegular }],
    }), 'ui-subagent: Execution page')
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: id, locale: NS, inject: executionActions,
      children: { 'execution.graph': { kind: 'chain', scope: 'session' } },
    }, ExecutionPanel))
    scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
      name: 'sidebar.right.pane.tab.title', key: id, locale: NS,
    }, ExecutionTitle))
  })
  ctx.slots.inject(
    'conversation.session.header.lineage',
    () => ctx.slots.register({
      name: 'conversation.session.header.lineage',
      locale: NS,
      inject: catalogActions,
    }, SubagentHeaderLineage),
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'subagent-catalog',
      // Leads the band, directly after the title crumbs: subagent lineage is
      // the title's own continuation, ahead of Team navigation (-20) and the
      // preset label (-10).
      order: -30,
      locale: NS,
      inject: catalogActions,
    }, SubagentCatalogAction),
  )
  ctx.slots.inject(
    'conversation.composer',
    () => ctx.slots.register({
      name: 'conversation.composer',
      priority: -10,
      locale: NS,
      select: selectReadOnlySubagent,
    }, SubagentReadOnlyComposer),
  )
}
