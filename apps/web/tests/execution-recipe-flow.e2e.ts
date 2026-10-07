/** Keyless assembled-browser acceptance for the Auto recipe map in Execution. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

interface RecipeFixtureEvent {
  readonly runId: string
  readonly recipe?: string
  readonly title?: string
  readonly task?: string
  readonly seq?: number
  readonly round?: number
  readonly role?: string
  readonly phase?: string
  readonly label?: string
  readonly provider?: string
  readonly model?: string
  readonly tier?: string
  readonly outcome?: string
  readonly summary?: string
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Synthetic Auto recipe start used by this keyless browser fixture. */
    'auto-recipe/run-start': RecipeFixtureEvent
    /** Synthetic Auto worker start used by this keyless browser fixture. */
    'auto-recipe/agent-start': RecipeFixtureEvent
    /** Synthetic Auto worker completion used by this keyless browser fixture. */
    'auto-recipe/agent-end': RecipeFixtureEvent
  }
}

const AUTO = fileURLToPath(new URL('../../../tariq/packages/auto-subagents', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/execution-recipe-flow', import.meta.url))
const MODE = webSnapshotMode()

describe('Execution recipe flow reuse', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ profile: { hmr: false, packages: [{ dir: AUTO, enabled: true }] } })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('reuses recipe stages, shows recorded node data on hover and follows live completion', async () => {
    onTestFailed(() => saveFailureShot(page, 'execution-recipe-flow'))
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('fixture workspace did not create an Agent')
    agent.session.append('auto-recipe/run-start', {
      runId: 'flow-first', recipe: 'feature-pipeline', title: 'Recipe flow fixture', task: 'Show the approved recipe stages',
    }, { ignorable: true })
    agent.session.append('auto-recipe/agent-start', {
      runId: 'flow-first', seq: 1, role: 'implement', label: 'Implementation fixture',
      provider: 'fixture-provider', model: 'fixture-sol-model', tier: 'strong',
    }, { ignorable: true })
    agent.session.append('auto-recipe/agent-end', {
      runId: 'flow-first', seq: 1, outcome: 'completed', summary: 'Implementation fixture completed',
    }, { ignorable: true })
    agent.session.append('auto-recipe/agent-start', {
      runId: 'flow-first', seq: 2, role: 'r1', label: 'Review fixture',
      provider: 'fixture-provider', model: 'fixture-review-model', tier: 'strong',
    }, { ignorable: true })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByRole('button', { name: 'View execution', exact: true }).first().click()
    const panel = page.locator('[data-execution-panel]')
    await panel.getByRole('tab', { name: 'Graph', exact: true }).click()
    const map = panel.locator('[data-recipe-execution]')
    await map.waitFor()
    expect(await map.locator('svg path').count()).toBeGreaterThan(0)
    expect(await map.locator('[data-role="r1"]').getAttribute('data-state')).toBe('active')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'flow.expected.md'), await captureStableAria(page, '[data-recipe-execution]', scaffold.workspaceCwd), MODE)
    const implementation = map.locator('[data-role="implement"]')
    await implementation.hover()
    const details = page.locator('[data-recipe-node-details]')
    await details.waitFor()
    await details.getByText('fixture-sol-model', { exact: true }).waitFor()
    await details.getByText('fixture-provider', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'details.expected.md'), await captureStableAria(page, '[data-recipe-node-details]', scaffold.workspaceCwd), MODE)
    await page.keyboard.press('Escape')
    await details.waitFor({ state: 'hidden' })
    await page.keyboard.press('Tab')
    await implementation.focus()
    await details.waitFor()
    await page.keyboard.press('Escape')
    await details.waitFor({ state: 'hidden' })
    agent.session.append('auto-recipe/agent-end', {
      runId: 'flow-first', seq: 2, outcome: 'completed', summary: 'Review fixture completed',
    }, { ignorable: true })
    await expect.poll(() => map.locator('[data-role="r1"]').getAttribute('data-state')).toBe('done')
    for (const [seq, role] of [[4, 'r2'], [5, 'r3']] as const) {
      agent.session.append('auto-recipe/agent-start', {
        runId: 'flow-first', seq, role, label: `Parallel ${role} fixture`,
        provider: 'fixture-provider', model: 'fixture-review-model', tier: 'strong',
      }, { ignorable: true })
    }
    await map.locator('[data-role="r3"][data-state="active"]').waitFor()
    const viewport = page.viewportSize()
    if (viewport === null) throw new Error('recipe layout requires a viewport')
    await page.setViewportSize({ ...viewport, width: 480 })
    await implementation.hover()
    await details.waitFor()
    const bounds = await details.boundingBox()
    if (bounds === null) throw new Error('recipe details did not have visible bounds')
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(480)
    await page.keyboard.press('Escape')
    await details.waitFor({ state: 'hidden' })
    await expect.poll(() => panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.setViewportSize(viewport)
    await page.emulateMedia({ colorScheme: 'dark' })
    await implementation.hover()
    await details.waitFor()
    const screenshot = process.env.DSH_EXECUTION_RECIPE_SCREENSHOT
    if (screenshot !== undefined) await page.screenshot({ path: screenshot, animations: 'disabled', fullPage: true })
    await page.keyboard.press('Escape')
    await page.emulateMedia({ colorScheme: 'light' })
    await implementation.click()
    await page.mouse.move(0, 0)
    await map.locator('.ars-detail:not(.ars-preview)').getByText('fixture-sol-model', { exact: true }).waitFor()
    for (const [seq, role] of [[10, 'setup'], [11, 'analysis'], [12, 'requirements']] as const) {
      agent.session.append('auto-recipe/agent-start', { runId: 'flow-first', seq, role }, { ignorable: true })
      agent.session.append('auto-recipe/agent-end', { runId: 'flow-first', seq, outcome: 'completed' }, { ignorable: true })
    }
    await map.getByRole('button', { name: /done · show/ }).click()
    expect(await map.locator('[aria-expanded="true"]').count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('selects the latest loaded recipe and keeps no-recipe sessions out of that map', async () => {
    onTestFailed(() => saveFailureShot(page, 'execution-recipe-reset'))
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('fixture workspace did not create an Agent')
    agent.session.append('auto-recipe/run-start', {
      runId: 'flow-second', recipe: 'investigate', title: 'Investigation fixture', task: 'Inspect the existing evidence',
    }, { ignorable: true })
    agent.session.append('auto-recipe/agent-start', {
      runId: 'flow-second', seq: 1, role: 'investigator', phase: 'gather', label: 'Gather fixture',
      provider: 'fixture-provider', model: 'fixture-gather-model', tier: 'medium',
    }, { ignorable: true })
    const panel = page.locator('[data-execution-panel]')
    await panel.locator('[data-recipe-execution] [data-role="investigator"]').waitFor()
    expect(await panel.locator('[data-role="implement"]').count()).toBe(0)
    expect(await panel.locator('.ars-detail:not(.ars-preview)').count()).toBe(0)
    agent.session.append('auto-recipe/run-start', {
      runId: 'flow-third', recipe: 'bug-fix', title: 'Bug fix fixture', task: 'Verify decision status',
    }, { ignorable: true })
    agent.session.append('auto-recipe/agent-start', {
      runId: 'flow-third', seq: 1, round: 1, role: 'implement', phase: 'code-loop', label: 'Fix fixture',
      provider: 'fixture-provider', model: 'fixture-fix-model', tier: 'strong',
    }, { ignorable: true })
    const decision = panel.locator('[data-recipe-execution] [data-role="decision"]')
    await decision.waitFor()
    expect(await decision.getAttribute('data-state')).toBe('done')
    await page.keyboard.press('Tab')
    await decision.focus()
    const decisionDetails = page.locator('[data-recipe-node-details]')
    await decisionDetails.getByText('Done', { exact: true }).waitFor()
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => panel.locator('[data-role="implement"]').evaluate(node => node === document.activeElement)).toBe(true)
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => decision.evaluate(node => node === document.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
    await decisionDetails.waitFor({ state: 'hidden' })
    // New session reuses truly blank sessions; establish a closed fixture turn first.
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    await page.getByRole('button', { name: 'View execution', exact: true }).first().click()
    await panel.getByRole('tab', { name: 'Graph', exact: true }).click()
    await expect.poll(() => panel.locator('[data-recipe-execution]').count()).toBe(0)
    expect(await panel.locator('[data-execution-child]').count()).toBe(0)
    await panel.getByRole('tab', { name: 'Agents', exact: true }).click()
    await panel.getByText('Coordinator', { exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['flow.expected.md', 'details.expected.md'])
  })
})
