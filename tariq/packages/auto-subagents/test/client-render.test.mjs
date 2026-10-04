// Loads current source in memory, without writing the parent's built browser artifacts,
// then folds realistic durable events through its ConversationNodeDefinition and renders the card
// with real React (react-dom/server). React resolves via test/support/react.mjs (package
// node_modules → REACT_DIR → /tmp/ars-test); a missing React fails loudly, never skips.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { React, renderToStaticMarkup } from './support/react.mjs';

function loadBundle() {
  const read = rel => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  const plain = rel => read(rel).replace(/^export\s+(const|function|let)\s/gm, '$1 ');
  const source = read('src/client.src.js')
    .replace('/*@@CARD_MODEL@@*/', () => plain('lib/card-model.mjs') + '\n' + plain('lib/decision-model.mjs'))
    .replace('/*@@SETTINGS@@*/', () => read('src/settings.src.js'))
    .replace('/*@@CSS@@*/', () => 'var CARD_CSS = ' + JSON.stringify(read('src/card.css')) + ';');
  const code = 'window.__ModuleLoader__.load({id:"dsh-auto-subagents",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n' + source + '\nreturn module.exports;}});';
  let exportsOf;
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ id, factory }) => { assert.equal(id, 'dsh-auto-subagents'); exportsOf = factory(name => { if (name === 'react') return React; throw new Error(`unexpected require ${name}`); }); } } },
    document: undefined, setInterval, clearInterval, console,
  };
  vm.runInNewContext(process.env.DSH_TEST_BUILT_CLIENT === '1' ? read('lib/client.js') : code, sandbox);
  return exportsOf;
}

const mod = loadBundle();
const { definition, RecipeRunPanel } = mod.__test;
const t = (key, vars) => { let s = key; if (vars) for (const [k, v] of Object.entries(vars)) s += ` ${k}=${v}`; return s; };

function fold(events) {
  let seq = 0, context = { key: 'k', id: 'r1' }, state, start;
  for (const [type, data] of events) {
    const event = { type, seq: ++seq, time: 1_000_000 + seq * 1000, data: { runId: 'r1', ...data }, ignorable: true };
    const m = definition.match(event);
    if (!m) continue;
    const match = { event, role: m.role, location: { kind: 'step' } };
    if (m.role === 'start') { start = match; state = definition.start({ ...context }, match, {}); }
    else state = definition.update({ ...context, state }, match);
  }
  return definition.buildViewNode({ key: 'k', id: 'r1', start, state, matches: [], current: new Map() });
}
const render = (node, extra = {}) => renderToStaticMarkup(React.createElement(RecipeRunPanel, { node, t, sessionId: 's', openSession: () => {}, ...extra }));
const RS = ['auto-recipe/run-start', { recipe: 'feature-pipeline', title: 'x', task: 'Add trim', repo: '/r', routes: {} }];
const A = (seq, label, role, round = 1, model = 'claude/sonnet') => ['auto-recipe/agent-start', { seq, label, role, round, childId: `child-${seq}`, model, tier: 'strong' }];
const E = (seq, outcome = 'completed') => ['auto-recipe/agent-end', { seq, outcome }];
const V = (seq, verdict) => ['auto-recipe/agent-end', { seq, verdict, findings: verdict === 'no' ? [{ severity: 'high', problem: 'order wrong' }] : [], annotate: true }];

const genericRecipes = {
  'bug-fix': ['analysis', 'build', 'review', 'validate'],
  'code-audit': ['scope', 'scans', 'verify'],
  investigate: ['scope', 'gather', 'check'],
  'qa-verify': ['analysis', 'verify', 'check'],
  'plan-to-packages': ['evidence', 'packages', 'check'],
  refactor: ['analysis', 'baseline', 'build', 'review', 'validate'],
};
for (const [recipe, phases] of Object.entries(genericRecipes)) {
  test(`${recipe}: source card and graph show recipe stages, every active child, no feature design`, () => {
    const node = fold([['auto-recipe/run-start', { recipe, title: 'Actual ' + recipe }],
      ['auto-recipe/agent-start', { seq: 1, label: 'custom-worker', role: 'other', phase: phases[0], childId: 'custom-child' }]]);
    const html = render(node);
    for (const phase of phases) assert.match(html, new RegExp('stage\\.' + phase));
    assert.doesNotMatch(html, /stage\.design/);
    assert.match(html, /custom-worker/);
    assert.match(html, /Actual /);
    assert.match(html, /foot\.agents n=1/);
    const graph = renderToStaticMarkup(React.createElement(mod.__test.FlowGraph, { t, state: node.data, selected: null, onSelect() {} }));
    assert.doesNotMatch(graph, /data-role="draft"|data-role="requirements"|node\.dreview/);
    assert.match(graph, /custom-worker/);
  });
}
test('unknown recipe renders observed phases and labels without inventing design or reviewers', () => {
  const node = fold([['auto-recipe/run-start', { recipe: 'custom' }],
    ['auto-recipe/agent-start', { seq: 1, label: 'discovery-worker', role: 'other', phase: 'discover' }],
    ['auto-recipe/agent-start', { seq: 2, label: 'another-worker', role: 'other', phase: 'discover' }]]);
  const html = render(node);
  assert.match(html, /discover/);
  assert.match(html, /discovery-worker/);
  assert.match(html, /another-worker/);
  assert.doesNotMatch(html, /stage\.design|stage\.build/);
});

test('module shape: apply/inject/name exported; definition ignores unrelated events', () => {
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual([...mod.inject], ['uiConversation', 'slots', 'sessions', 'locale', 'configForms', 'remote', 'remote.session', 'uiWorkspace']);
  assert.equal(definition.match({ type: 'tool/call', data: {} }), null);
  assert.equal(definition.match({ type: 'auto-recipe/agent-start', data: {} }), null, 'events without runId are ignored');
});

test('decision state renders the question, options and an enabled send button only with inputActions', () => {
  const node = fold([RS, A(1, 'setup', 'setup'), E(1), A(2, 'analysis', 'analysis'), E(2),
    ['auto-recipe/decision', { resumeId: 'res-1', questions: [{ id: 'q1', question: 'Q text?', current: 'today X', recommendation: 'Keep', options: [{ label: 'Keep', consequence: 'nothing changes' }, { label: 'Change', consequence: 'breaks test' }] }], decidedForYou: [{ id: 'd1', decision: 'auto' }] }],
    ['auto-recipe/run-end', { status: 'needs_decision' }]]);
  assert.equal(node.kind, 'auto-recipe-run');
  const withoutInput = render(node);
  assert.match(withoutInput, /Q text\?/);
  assert.match(withoutInput, /today X/);
  assert.match(withoutInput, /nothing changes/);
  assert.match(withoutInput, /pill\.decision/);
  assert.match(withoutInput, /<button[^>]*class="ars-btn primary"[^>]*disabled=""/, 'send disabled without inputActions');
  const withInput = render(node, { inputActions: { setDraft() {}, submit() {} } });
  assert.match(withInput, /<button[^>]*class="ars-btn primary"[^>]*disabled=""/, 'draft API alone cannot submit a decision');
  const withPending = render(node, { useSessionStatus: select => select(new Map([['s', {pendingInteraction:{sessionId:'s',kind:'question',questions:[{id:'r1:q1'}],answer:async()=>{}}}]])) });
  assert.match(withPending, /<button[^>]*class="ars-btn primary"[^>]*disabled=""/, 'even matched questions require explicit human choice');
});

test('repair state: running implementer row with model + open, rejected reviewers shown, ×2 loop on strip', () => {
  const node = fold([RS, A(7, 'implement #1', 'implement'), E(7), A(8, 'review-1 #1', 'r1', 1, 'codex/gpt'), A(9, 'review-2 #1', 'r2', 1, 'claude/opus'),
    V(8, 'no'), V(9, 'no'), E(8), E(9), A(10, 'aggregate #1', 'aggregate'), V(10, 'no'), E(10), A(11, 'implement #2', 'implement', 2)]);
  const html = render(node);
  assert.match(html, /pill\.repair/);
  assert.match(html, /ars-loop-n">×2</);
  assert.match(html, /data-state="failed"[^>]*aria-label="stage\.review/);
  assert.match(html, />sonnet</, 'model shown without provider prefix');
  assert.match(html, /verdict\.no/);
  assert.match(html, /ars-open"[^>]*aria-label="open\.session/);
});

test('completed state: all stages done, passed + changed files in footer, no decision box', () => {
  const node = fold([RS, A(14, 'validate', 'validate'), E(14), ['auto-recipe/run-end', { status: 'completed', passed: '13/13', changedPaths: ['src/a.js', 'test/a.test.js'] }]]);
  const html = render(node);
  assert.match(html, /pill\.done/);
  assert.match(html, /foot\.passed p=13\/13/);
  assert.match(html, /foot\.changed files=src\/a\.js، test\/a\.test\.js/);
  assert.doesNotMatch(html, /ars-decision/);
});

test('aborted and error states render failure footers', () => {
  assert.match(render(fold([RS, A(7, 'implement #3', 'implement', 3), E(7), ['auto-recipe/run-end', { status: 'aborted' }]])), /foot\.aborted n=3/);
  assert.match(render(fold([RS, ['auto-recipe/run-end', { status: 'error', error: 'boom' }]])), /foot\.error e=boom/);
});

test('graph layout: nodes never overlap; reviewers fit inside the 520px plane for 2 and 3 reviewers', () => {
  const { layoutGraph } = mod.__test;
  for (const reviewers of [['r1', 'r2'], ['r1', 'r2', 'r3']]) {
    const L = layoutGraph({}, reviewers, true);
    const boxes = Object.entries(L.pos).map(([k, p]) => ({ k, l: p.x, r: p.x + p.w, t: p.y, b: p.y + 64 }));
    for (const b of boxes) assert.ok(b.l >= 0 && b.r <= 520, `${b.k} inside plane`);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], c = boxes[j];
      assert.ok(!(a.l < c.r && a.r > c.l && a.t < c.b && a.b > c.t), `${a.k} overlaps ${c.k}`);
    }
  }
});

const DEC = ['auto-recipe/decision', { resumeId: 'res-1', questions: [{ id: 'q1', question: 'Q?', options: [{ label: 'Same', consequence: 'a' }, { label: 'Same', consequence: 'b' }] }], decidedForYou: [{ id: 'd1', decision: 'auto' }] }];
const decisionNode = () => fold([RS, DEC, ['auto-recipe/run-end', { status: 'needs_decision' }]]);

test('card direction follows the active locale (not hardcoded rtl)', () => {
  const node = decisionNode();
  assert.match(render(node, { localeId: 'ar' }), /<section class="ars-card" dir="rtl"/);
  assert.match(render(node, { localeId: 'en' }), /<section class="ars-card" dir="ltr"/);
  assert.match(render(node), /<section class="ars-card" dir="ltr"/, 'no locale and no document → ltr');
});

test('option keys are unique even when labels repeat', () => {
  const { optionKey } = mod.__test;
  const keys = [{ label: 'Same' }, { label: 'Same' }].map((o, i) => optionKey(o, i));
  assert.equal(new Set(keys).size, 2);
});

test('pending batch with decidedForYou override ids still binds the card', () => {
  const pend = { sessionId: 's', kind: 'question', questions: [{ id: 'r1:q1' }, { id: 'r1:d1' }], answer: async () => {} };
  const html = render(decisionNode(), { useSessionStatus: select => select(new Map([['s', {pendingInteraction:pend}]])) });
  assert.match(html, /class="ars-decision"[^>]*data-live="true"/);
  const stale = { ...pend, questions: [{ id: 'r1:q1' }, { id: 'r1:other' }] };
  assert.match(render(decisionNode(), { useSessionStatus: select => select(new Map([['s', {pendingInteraction:stale}]])) }), /class="ars-decision"[^>]*data-live="false"/);
});

test('graph canvas is wrapped in a horizontally scrollable viewport', () => {
  const { FlowGraph } = mod.__test;
  const html = renderToStaticMarkup(React.createElement(FlowGraph, { t, state: decisionNode().data, now: 0, selected: null, hlStage: null, showDone: true, onToggleDone() {}, onSelect() {} }));
  assert.match(html, /class="ars-flow-scroll"[^>]*><div class="ars-flow"/);
});

test('css: only the graph planes force ltr; text blocks follow the card direction', () => {
  const css = readFileSync(new URL('../src/card.css', import.meta.url), 'utf8');
  for (const sel of ['.ars-stage', '.ars-section', '.ars-agent', '.ars-elbl', '.ars-glbl', '.ars-fnode']) {
    const rule = new RegExp(`(^|\\n)\\${sel} \\{[^}]*\\}`).exec(css);
    assert.ok(rule, `${sel} rule exists`);
    assert.doesNotMatch(rule[0], /direction:\s*rtl/, `${sel} must not force rtl`);
  }
  assert.match(css, /\.ars-flow-scroll \{[^}]*overflow-x: auto/);
});

test('Auto settings renders saved unavailable routes, tiers and the disabled state', () => {
  const html = renderToStaticMarkup(React.createElement(mod.__test.AutoSettings, {
    t, useAutoSettings: select => select({status:'ready',writable:true,revision:1,value:{enabled:false,allowedModels:[{provider:'offline',model:'saved-model'}],modelTiers:[{provider:'offline',model:'saved-model',tier:'strong'}]}}),
    catalog: async () => ({ok:true,value:{groups:[],failures:[]}}), save: async () => true,
  }));
  assert.match(html, /<strong>saved-model<\/strong>/);
  assert.match(html, /<span>offline<\/span>/);
  assert.match(html, /value="strong" selected=""/);
  assert.doesNotMatch(html, /checked=""/);
});

const recipeCatalog = [
  { name: 'bug-fix', description: 'Fix a defect', whenToUse: '', options: [],
    stages: [{ id: 'setup', roles: ['setup'], detail: 'Inspect repo' }, { id: 'code-loop', roles: ['implementer', 'reviewer'], loop: true, parallel: true, detail: '' }],
    roles: [{ role: 'setup', tier: 'light', locked: false }, { role: 'implementer', tier: 'strong', locked: true }, { role: 'reviewer', tier: 'strong', locked: true }] },
  { name: 'feature-pipeline', description: 'Build a feature', whenToUse: '',
    options: [{ key: 'fastPath', default: true, detail: 'boolean, default true' }],
    stages: [{ id: 'setup', roles: ['setup'], detail: '' }], roles: [{ role: 'setup', tier: 'light', locked: false }] },
];
const settingsWith = recipeOverrides => ({ t, recipes: recipeCatalog,
  useAutoSettings: select => select({ status: 'ready', writable: true, revision: 1, value: { enabled: true, allowedModels: [{ provider: 'p', model: 'm' }], modelTiers: [], ...(recipeOverrides ? { recipeOverrides } : {}) } }),
  catalog: async () => ({ ok: true, value: { groups: [], failures: [] } }), save: async () => true });

test('recipe canvas renders a tab per recipe and the first recipe flow with stage badges and role tiers', () => {
  const html = renderToStaticMarkup(React.createElement(mod.__test.AutoSettings, settingsWith(undefined)));
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 2);
  assert.match(html, /aria-selected="true"[^>]*>.*bug-fix/);
  assert.match(html, /class="ars-canvas"/);
  assert.match(html, /data-stage="code-loop"/);
  assert.match(html, /loopBadge/);
  assert.match(html, /parallelBadge/);
  assert.match(html, /data-role="implementer" data-tier="strong"/);
  assert.match(html, /data-role="setup" data-tier="light"/);
  assert.match(html, /recipeEnabled/);
});

test('recipe canvas shows saved tier, timeout and disabled overrides', () => {
  const html = renderToStaticMarkup(React.createElement(mod.__test.AutoSettings, settingsWith({ 'bug-fix': { disabled: true, roles: { setup: { tier: 'medium', timeoutMinutes: 4 } } } })));
  assert.match(html, /data-role="setup" data-tier="medium" data-custom="true"/);
  assert.match(html, /minutes n=4/);
  assert.match(html, /data-off="true"/);
});

test('recipe settings helpers drop empty overrides and validate timeouts', () => {
  const { setRoleOverride, setRecipeEntry, recipeOverridesInvalid } = mod.__test;
  let ov = setRoleOverride({}, 'bug-fix', 'setup', { tier: 'medium' });
  assert.deepEqual(JSON.parse(JSON.stringify(ov)), { 'bug-fix': { roles: { setup: { tier: 'medium' } } } });
  ov = setRoleOverride(ov, 'bug-fix', 'setup', { tier: undefined });
  assert.deepEqual(JSON.parse(JSON.stringify(ov)), {});
  ov = setRecipeEntry({}, 'feature-pipeline', { args: { fastPath: false } });
  assert.deepEqual(JSON.parse(JSON.stringify(ov)), { 'feature-pipeline': { args: { fastPath: false } } });
  assert.equal(recipeOverridesInvalid({ a: { roles: { s: { timeoutMinutes: 0 } } } }), true);
  assert.equal(recipeOverridesInvalid({ a: { roles: { s: { timeoutMinutes: 240 } } } }), false);
});
