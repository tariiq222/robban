// Web client half of dsh-auto-subagents. Built into lib/client.js by build.mjs, which wraps it in
// the DSH module-loader envelope and inlines card-model.mjs (marked below).
//
// Registers:
//   - a ConversationNodeDefinition (kind "auto-recipe-run") folding `auto-recipe/*` session events;
//   - a keyed 'conversation.chat.node' renderer for that kind: the run card, the full flow graph
//     (in an in-card drawer) and the per-node detail panel;
//   - English UI copy; full application localization is deferred.
//
// Dependencies are only the shared platform modules: react and @deepseek-ai/dsh-client-store is
// NOT needed. Styles use DSH theme variables (--dsw-alias-*), with fallbacks.

var React = require("react");
var h = React.createElement;
var useState = React.useState, useEffect = React.useEffect, useMemo = React.useMemo, useRef = React.useRef;

/*@@CARD_MODEL@@*/

var KIND = "auto-recipe-run";
var NS = "autoRecipe";
var CSS_ID = "dsh-auto-subagents/card.css";

// ───────────────────────── locale ─────────────────────────
var ar = {
  "title": "تعديل كود مع مراجعة مستقلة",
  "graph": "المخطط", "graph.title": "المخطط الكامل", "close": "إغلاق",
  "pill.running": "يشتغل", "pill.repair": "يصلّح", "pill.decision": "ينتظر قرارك", "pill.done": "اكتمل", "pill.failed": "توقف",
  "stage.analysis": "التحليل", "stage.decision": "قرارك", "stage.design": "التصميم", "stage.build": "التنفيذ", "stage.review": "المراجعة", "stage.validate": "التحقق",
  "stage.scope": "النطاق", "stage.scans": "الفحص", "stage.gather": "جمع الأدلة", "stage.check": "المراجعة المستقلة", "stage.evidence": "الأدلة", "stage.packages": "حزم العمل", "stage.verify": "التحقق", "stage.baseline": "خط الأساس", "stage.agents": "الوكلاء",
  "state.done": "خلص", "state.active": "شغّال الحين", "state.pending": "ما بدأ", "state.failed": "فيه رفض", "state.decision": "ينتظر قرارك",
  "node.setup": "الإعداد", "node.analysis": "تحليل النطاق", "node.decision": "قرارك", "node.requirements": "المتطلبات", "node.draft": "مسودة التصميم",
  "node.dreview": "مراجعة التصميم", "node.plan": "الخطة", "node.implement": "التنفيذ", "node.reviewer": "مراجع {n}", "node.aggregate": "القرار", "node.validate": "التحقق النهائي",
  "running.now": "شغّال الحين", "agents": "الوكلاء", "agents.more": "+ {n} وكلاء خلصوا", "agents.all": "عرض الوكلاء ({n})", "agents.hide": "إخفاء",
  "open": "فتح", "read": "قراءة", "open.session": "فتح الجلسة", "read.session": "قراءة الجلسة",
  "verdict.ok": "وافق", "verdict.no": "رفض",
  "decision.title": "يحتاج قرارك قبل ما يكمّل", "decision.current": "الوضع الحالي:", "decision.recommended": "مقترح",
  "decision.decided": "قررته عنك ({n}) · تقدر تغيّره", "decision.send": "أرسل الجواب وكمّل", "decision.note": "يكمّل من بعد التحليل بدون ما يعيده",
  "decision.sent": "انرسل الجواب", "decision.count": "{n} سؤال", "decision.custom": "جواب ثاني…",
  "foot.agents": "{n} وكلاء", "foot.changed": "تعدّل: {files}", "foot.passed": "التحقق: {p}", "foot.ended": "ما يحتاج تعديل", "foot.aborted": "توقف بعد {n} جولات بدون موافقة · التعديلات باقية بدون commit",
  "foot.error": "خطأ: {e}", "foot.cancelled": "انلغى",
  "loop": "حتى 3 جولات", "parallel": "بالتوازي", "reject": "رفض", "repair": "إصلاح ×{n}", "reject3": "رفض ×{n}",
  "done.n": "{label} خلصت · اعرضها", "done.hide": "إخفاء الخطوات اللي خلصت",
  "legend.done": "خلص", "legend.active": "شغّال", "legend.decision": "ينتظرك", "legend.failed": "رفض", "legend.pending": "ما بدأ",
  "detail.empty": "انقر على أي كرت أو مرحلة لعرض التفاصيل", "detail.stage": "المرحلة", "detail.state": "الحالة", "detail.tier": "الـ tier",
  "detail.model": "الموديل", "detail.round": "الجولة", "detail.duration": "المدة", "detail.rounds": "{n} من 3",
  "kbd": "↑↓ تنقّل · Enter تفاصيل · Esc إغلاق",
  "steps.1": "خطوة وحدة", "steps.2": "خطوتين", "steps.few": "{n} خطوات", "steps.many": "{n} خطوة"
};
var en = {
  "title": "Code change with independent review",
  "graph": "Diagram", "graph.title": "Full diagram", "close": "Close",
  "pill.running": "Running", "pill.repair": "Repairing", "pill.decision": "Needs your decision", "pill.done": "Done", "pill.failed": "Stopped",
  "stage.analysis": "Analysis", "stage.decision": "Decision", "stage.design": "Design", "stage.build": "Build", "stage.review": "Review", "stage.validate": "Validate",
  "stage.scope": "Scope", "stage.scans": "Scans", "stage.gather": "Gather evidence", "stage.check": "Independent check", "stage.evidence": "Evidence", "stage.packages": "Work packages", "stage.verify": "Verify", "stage.baseline": "Baseline", "stage.agents": "Agents",
  "state.done": "Done", "state.active": "Running", "state.pending": "Not started", "state.failed": "Rejected", "state.decision": "Waiting for you",
  "node.setup": "Setup", "node.analysis": "Scoped analysis", "node.decision": "Your decision", "node.requirements": "Requirements", "node.draft": "Design draft",
  "node.dreview": "Design review", "node.plan": "Plan", "node.implement": "Implement", "node.reviewer": "Reviewer {n}", "node.aggregate": "Verdict", "node.validate": "Final validation",
  "running.now": "Running now", "agents": "Agents", "agents.more": "+ {n} finished agents", "agents.all": "Show agents ({n})", "agents.hide": "Hide",
  "open": "Open", "read": "Read", "open.session": "Open session", "read.session": "Read session",
  "verdict.ok": "Approved", "verdict.no": "Rejected",
  "decision.title": "Needs your decision before continuing", "decision.current": "Current state:", "decision.recommended": "Recommended",
  "decision.decided": "Decided for you ({n}) · you can override", "decision.send": "Send answer and continue", "decision.note": "Continues after the analysis without redoing it",
  "decision.sent": "Answer sent", "decision.count": "{n} question(s)", "decision.custom": "Other answer…",
  "foot.agents": "{n} agents", "foot.changed": "Changed: {files}", "foot.passed": "Validation: {p}", "foot.ended": "Nothing to change", "foot.aborted": "Stopped after {n} rounds without approval · changes left uncommitted",
  "foot.error": "Error: {e}", "foot.cancelled": "Cancelled",
  "loop": "up to 3 rounds", "parallel": "parallel", "reject": "rejected", "repair": "repair ×{n}", "reject3": "rejected ×{n}",
  "done.n": "{label} done · show", "done.hide": "Hide finished steps",
  "legend.done": "Done", "legend.active": "Running", "legend.decision": "Waiting", "legend.failed": "Rejected", "legend.pending": "Not started",
  "detail.empty": "Click a card or stage to see details", "detail.stage": "Stage", "detail.state": "State", "detail.tier": "Tier",
  "detail.model": "Model", "detail.round": "Round", "detail.duration": "Duration", "detail.rounds": "{n} of 3",
  "kbd": "↑↓ move · Enter details · Esc close",
  "steps.1": "1 step", "steps.2": "2 steps", "steps.few": "{n} steps", "steps.many": "{n} steps"
};

// ───────────────────────── conversation definition ─────────────────────────
var TYPES = { "auto-recipe/run-start": 1, "auto-recipe/agent-start": 1, "auto-recipe/agent-end": 1, "auto-recipe/status": 1, "auto-recipe/decision": 1, "auto-recipe/run-end": 1 };

var definition = {
  kind: KIND,
  target: "chat",
  match: function (event) {
    if (!event || !TYPES[event.type] || !event.data || typeof event.data.runId !== "string") return null;
    return { id: event.data.runId, role: event.type === "auto-recipe/run-start" ? "start" : "update" };
  },
  start: function (_context, match) {
    var d = match.event.data;
    return initialState(Object.assign({}, d, { at: match.event.time }));
  },
  update: function (context, match) {
    return reduce(context.state, match.event.type, match.event.data, match.event.time);
  },
  buildViewNode: function (context) {
    if (context.start === undefined || context.state === undefined) return null;
    return {
      key: context.key, kind: KIND, id: context.id, target: "chat",
      anchorSeq: context.start.event.seq, location: context.start.location, visibility: "visible",
      data: context.state
    };
  }
};

// ───────────────────────── helpers ─────────────────────────
function fmt(ms) { return fmtDuration(ms); }
function optionKey(option, index) { return index + ":" + option.label; }
function useNow(active) {
  var pair = useState(Date.now());
  useEffect(function () {
    if (!active) return undefined;
    var id = setInterval(function () { pair[1](Date.now()); }, 1000);
    return function () { clearInterval(id); };
  }, [active]);
  return pair[0];
}
function steps(t, n) { return n === 1 ? t("steps.1") : n === 2 ? t("steps.2") : n <= 10 ? t("steps.few", { n: n }) : t("steps.many", { n: n }); }
function cls() { return Array.prototype.filter.call(arguments, Boolean).join(" "); }
function ltr(text, extra) { return h("bdi", { dir: "ltr", className: cls("ars-ltr", extra) }, text); }
function shortModel(m) { return String(m || "").replace(/^.*\//, ""); }

var ICON = {
  check: "M3.5 8.5l3 3 6-7", x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  q: "M6 6a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5", pipeline: "M4.8 8H8m0 0l3.3-3.2M8 8l3.3 3.2",
  expand: "M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9", open: "M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5",
  doc: "M4 2h5l3 3v9H4zM6 8h4M6 11h4", warn: "M8 2.5l6 10.5H2zM8 6.5v3", send: "M13.5 2.5L7 9M13.5 2.5l-4 11-2.5-4.5L2.5 6.5z",
  chev: "M4 6l4 4 4-4", close: "M4 4l8 8M12 4l-8 8", clock: "M8 4.5V8l2.2 1.4"
};
function Icon(props) {
  var extra = props.name === "pipeline" ? [h("circle", { key: "a", cx: 3, cy: 8, r: 1.8 }), h("circle", { key: "b", cx: 13, cy: 4, r: 1.8 }), h("circle", { key: "c", cx: 13, cy: 12, r: 1.8 })]
    : props.name === "q" ? [h("circle", { key: "a", cx: 8, cy: 12, r: 0.6, fill: "currentColor" })]
    : props.name === "warn" ? [h("circle", { key: "a", cx: 8, cy: 11.3, r: 0.5, fill: "currentColor" })]
    : props.name === "clock" ? [h("circle", { key: "a", cx: 8, cy: 8, r: 5.5 })] : [];
  return h("svg", { viewBox: "0 0 16 16", width: props.size || 14, height: props.size || 14, fill: "none", stroke: "currentColor", strokeWidth: props.w || 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
    extra.concat([h("path", { key: "p", d: ICON[props.name] })]));
}
var NODE_ICON = {
  setup: "M3 6h14M3 10h9M3 14h6", analysis: "M13 13l4 4", decision: "M4 4h12v9H9l-4 3v-3H4z", requirements: "M7 8l1.5 1.5L11 7M7 13h6",
  draft: "M4 16l2.5-.6L15 7l-1.9-1.9L4.6 13.5zM12 6l2 2", review: "M2.5 10s3-5.5 7.5-5.5S17.5 10 17.5 10 14.5 15.5 10 15.5 2.5 10 2.5 10z",
  plan: "M5 5h10M5 10h10M5 15h6", implement: "M7 6l-4 4 4 4M13 6l4 4-4 4M11 4l-2 12", aggregate: "M5 3v4a3 3 0 0 0 3 3h4a3 3 0 0 1 3 3v4M15 3v4a3 3 0 0 1-3 3",
  validate: "M10 2.5l6 2.5v4.5c0 4-2.7 6.7-6 8-3.3-1.3-6-4-6-8V5zM7.5 10l1.8 1.8L13 8"
};
function NodeIcon(props) {
  var key = /^r\d+$/.test(props.role) || props.role === "dreview" ? "review" : props.role;
  var extra = key === "analysis" ? [h("circle", { key: "c", cx: 9, cy: 9, r: 5 })] : key === "review" ? [h("circle", { key: "c", cx: 10, cy: 10, r: 2.3 })]
    : key === "setup" ? [h("circle", { key: "c", cx: 15, cy: 13, r: 2.5 })] : key === "requirements" ? [h("rect", { key: "c", x: 4, y: 3, width: 12, height: 14, rx: 2 })] : [];
  return h("svg", { viewBox: "0 0 20 20", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
    extra.concat([h("path", { key: "p", d: NODE_ICON[key] || NODE_ICON.plan })]));
}
var ST_ICON = { done: "check", failed: "x", decision: "q" };

function nodeTitle(t, role) {
  var m = /^r(\d+)$/.exec(role);
  return m ? t("node.reviewer", { n: m[1] }) : t("node." + role);
}

function stageTitle(t, id) { return Object.hasOwn(en, 'stage.' + id) ? t('stage.' + id) : id; }
function agentTitle(t, agent) {
  return agent.role && agent.role !== 'other' && (en['node.' + agent.role] || /^r\d+$/.test(agent.role)) ? nodeTitle(t, agent.role) : agent.label || agent.role || '';
}
function selectedStage(state, key) {
  var a = nodesOf(state).latest[key];
  return a ? agentStage(state, a) : key === 'decision' ? 'decision' : stageOfNode(key);
}

// ───────────────────────── card ─────────────────────────
function StageStrip(props) {
  var t = props.t, st = props.stages, s = props.state;
  var cells = [], conns = [];
  var order = stageOrderOf(s), generic = !isFeatureRecipe(s);
  order.forEach(function (id, i) {
    var info = st[id] || { state: "pending" };
    var sub = id === "decision" && info.state === "decision" ? t("decision.count", { n: info.sub }) : "";
    cells.push(h("button", { key: id, type: "button", className: "ars-stage", "data-state": info.state, style: generic ? undefined : { gridArea: "s" + (i + 1) },
      onClick: function () { props.onStage(id); }, "aria-label": stageTitle(t, id) + ": " + t("state." + info.state) },
      h("span", { className: "ars-node", "aria-hidden": true }, ST_ICON[info.state] ? h(Icon, { name: ST_ICON[info.state], w: 2.4 }) : info.state === "active" ? h("span", { className: "ars-dot-in" }) : null),
      h("span", { className: "ars-lbl" }, stageTitle(t, id)),
      h("span", { className: "ars-sub" }, sub ? String(sub) : "\u00a0")));
    if (!generic && i < order.length - 1) {
      var loop = id === "build" && (st.build.rounds || 0) > 1;
      var cs = loop ? "loop" : info.state === "done" ? "done" : "";
      conns.push(h("span", { key: "c" + i, className: "ars-conn", "data-state": cs, style: { gridArea: "c" + (i + 1) }, "aria-hidden": true },
        h("svg", { viewBox: "0 0 22 30", preserveAspectRatio: "none" },
          h("path", { d: "M20 12H3" }), h("path", { d: "M8 7 3 12l5 5" }),
          loop ? h("path", { d: "M3 24h17", strokeDasharray: "2 3" }) : null, loop ? h("path", { d: "M15 19l5 5-5 5" }) : null),
        loop ? h("span", { className: "ars-loop-n" }, "×" + st.build.rounds) : null));
    }
  });
  return h("div", { className: cls("ars-stages", generic && "ars-stages-generic") }, cells.concat(conns));
}

function AgentRow(props) {
  var a = props.agent, t = props.t, running = a.outcome === undefined;
  return h("div", { className: "ars-agent" },
    h("span", { className: cls("ars-dot", running ? "running" : "done"), "aria-hidden": true }),
    h("span", { className: "ars-role" }, agentTitle(t, a), a.round > 1 ? h("small", null, " · #" + a.round) : null),
    a.model ? ltr(shortModel(a.model), "ars-model") : null,
    a.verdict === "ok" || a.verdict === "no" ? h("span", { className: cls("ars-verdict", a.verdict) }, t("verdict." + a.verdict)) : null,
    h("span", { className: "ars-gap" }),
    running && a.startedAt ? h("span", { className: "ars-clock" }, fmt(props.now - a.startedAt)) : null,
    a.childId ? h("button", { type: "button", className: cls("ars-open", running ? "" : "read"), onClick: function () { props.openSession(a.childId); },
      "aria-label": (running ? t("open.session") : t("read.session")) + ": " + agentTitle(t, a) },
      h(Icon, { name: running ? "open" : "doc", size: 13 }), running ? t("open") : t("read")) : null);
}

function DecisionBox(props) {
  var t = props.t, d = props.decision;
  var init = {};
  d.questions.forEach(function (q) { init[q.id] = { choice: "", custom: "" }; }); // never pre-consent on the human's behalf
  var pair = useState(init); var answers = pair[0], setAnswers = pair[1];
  var sentPair = useState(false); var sent = sentPair[0], setSent = sentPair[1];
  function pick(qid, choice) { var n = Object.assign({}, answers); n[qid] = { choice: choice, custom: "" }; setAnswers(n); }
  function custom(qid, text) { var n = Object.assign({}, answers); n[qid] = { choice: "__custom", custom: text }; setAnswers(n); }
  var errPair = useState("");
  async function send() {
    if (!props.canAnswer || sent) return;
    try { await props.onAnswer(answers); setSent(true); errPair[1](""); }
    catch (e) { errPair[1](String(e.message || e)); }
  }
  var complete = d.questions.every(function(q) { var a = answers[q.id] || {}; var x = a.choice === '__custom' ? a.custom : a.choice; return typeof x === 'string' && x.trim(); });
  return h("div", { className: "ars-decision", role: "region", "aria-label": t("decision.title"), "data-live": String(!!props.canAnswer) },
    h("h4", null, h(Icon, { name: "warn" }), t("decision.title")),
    d.questions.map(function (q) {
      var a = answers[q.id] || {};
      return h("div", { key: q.id, className: "ars-q" },
        h("div", { className: "ars-qtext", id: "ars-q-" + q.id }, q.question),
        q.current ? h("div", { className: "ars-current" }, h("b", null, t("decision.current") + " "), q.current) : null,
        h("div", { className: "ars-opts", role: "radiogroup", "aria-labelledby": "ars-q-" + q.id },
          q.options.map(function (o, oi) {
            var rec = q.recommendation && o.label.indexOf(q.recommendation) === 0 || q.recommendation === o.label;
            return h("button", { key: optionKey(o, oi), type: "button", role: "radio", className: "ars-opt", "aria-checked": a.choice === o.label, disabled: sent, onClick: function () { pick(q.id, o.label); } },
              h("span", { className: "ars-radio", "aria-hidden": true }),
              h("span", null, rec ? h("span", { className: "ars-tag" }, t("decision.recommended")) : null, o.label, o.consequence ? h("span", { className: "ars-cons" }, o.consequence) : null));
          }),
          h("input", { className: "ars-custom", type: "text", placeholder: t("decision.custom"), disabled: sent, value: a.choice === "__custom" ? a.custom : "", onChange: function (e) { custom(q.id, e.target.value); } })));
    }),
    d.decidedForYou.length ? h("details", { className: "ars-decided" }, h("summary", null, t("decision.decided", { n: d.decidedForYou.length })),
      h("ul", null, d.decidedForYou.map(function (x) { return h("li", { key: x.id }, ltr(x.id), " → ", x.decision); }))) : null,
    h("div", { className: "ars-q-actions" },
      h("button", { type: "button", className: "ars-btn primary", disabled: sent || !props.canAnswer || !complete, onClick: send }, h(Icon, { name: "send" }), sent ? t("decision.sent") : t("decision.send")),
      errPair[0] ? h('span', {role:'alert'}, errPair[0]) : null,
      h("span", { className: "ars-note" }, t("decision.note"))));
}

// ───────────────────────── flow graph ─────────────────────────
var GW = 520, CX = 280, NW = 300, NH = 64, NX = CX - NW / 2;

function layoutGraph(latest, reviewerRoles, showDone) {
  var prefix = ["setup", "analysis", "decision", "requirements", "draft", "dreview", "plan"];
  var done = function (r) { return r === "decision" ? latest.requirements !== undefined : nodeState(latest[r]) === "done"; };
  var hidden = {};
  if (!showDone) { for (var i = 0; i < prefix.length; i++) { if (done(prefix[i])) hidden[prefix[i]] = true; else break; } }
  var hiddenList = Object.keys(hidden);
  if (hiddenList.length) delete hidden[hiddenList[hiddenList.length - 1]];
  if (Object.keys(hidden).length < 2) hidden = {};
  var pos = {}, y = 0, gap = 32, pad = 26;
  ["setup", "analysis", "decision", "requirements"].forEach(function (id) { if (!hidden[id]) { pos[id] = { x: NX, y: y, w: NW }; y += NH + gap; } });
  var design = ["draft", "dreview"].filter(function (id) { return !hidden[id]; });
  if (design.length) { y += pad; design.forEach(function (id) { pos[id] = { x: NX, y: y, w: NW }; y += NH + gap; }); y += 14; }
  if (!hidden.plan) { pos.plan = { x: NX, y: y, w: NW }; y += NH + gap; }
  y += pad; pos.implement = { x: NX, y: y, w: NW }; y += NH + 50;
  var rs = reviewerRoles.length ? reviewerRoles : ["r1", "r2"];
  var rw = rs.length <= 2 ? 210 : Math.floor((GW - 80 - (rs.length - 1) * 16) / rs.length);
  var startX = rs.length <= 2 ? 64 : 64;
  rs.forEach(function (r, i) { pos[r] = { x: startX + i * (rw + 16), y: y, w: rw }; });
  if (rs.length === 2) pos[rs[1]].x = 290;
  y += NH + 50;
  pos.aggregate = { x: NX, y: y, w: NW }; y += NH + gap + 14;
  pos.validate = { x: NX, y: y, w: NW }; y += NH + 8;
  return { pos: pos, hiddenCount: Object.keys(hidden).length, H: y, reviewers: rs };
}

// Ordered phase groups expose the real workers; no arrows claim unsupported dependencies.
function GenericGraph(props) {
  var t = props.t, s = props.state, latest = nodesOf(s).latest, stages = stagesOf(s);
  return h('div', { className: 'ars-graph ars-generic-graph' }, stageOrderOf(s).map(function (id) {
    var keys = nodeKeysForStage(s, id), state = stages[id].state;
    return h('section', { key: id, className: 'ars-phase-group', 'data-stage': id, 'data-hl': props.hlStage === id, 'aria-label': stageTitle(t, id) },
      h('h4', null, stageTitle(t, id), h('span', { className: 'ars-phase-state' }, t('state.' + state))),
      id === 'decision' ? h('button', { type: 'button', className: 'ars-generic-node', 'data-state': state, 'aria-pressed': props.selected === 'decision', onClick: function () { props.onSelect('decision'); } }, nodeTitle(t, 'decision')) : null,
      keys.map(function (key) {
        var a = latest[key], status = nodeState(a);
        return h('button', { key: key, type: 'button', className: 'ars-generic-node', 'data-role': key, 'data-state': status,
          'aria-pressed': props.selected === key, 'aria-label': agentTitle(t, a) + ': ' + t('state.' + status),
          onClick: function () { props.onSelect(props.selected === key ? null : key); },
          onKeyDown: function (e) {
            if (e.key === 'Escape') props.onSelect(null);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              var list = e.currentTarget.closest('.ars-generic-graph').querySelectorAll('button');
              var index = Array.prototype.indexOf.call(list, e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1);
              if (list[index]) list[index].focus();
            }
          } },
          h(NodeIcon, { role: a.role }), h('span', { className: 'ars-generic-title' }, agentTitle(t, a)),
          a.model ? ltr(shortModel(a.model), 'ars-model') : null,
          h('span', { className: 'ars-chip' }, t('state.' + status)),
          a.verdict ? h('span', { className: cls('ars-chip', a.verdict === 'ok' ? 'ok' : 'no') }, t('verdict.' + (a.verdict === 'ok' ? 'ok' : 'no'))) : null);
      }));
  }));
}

function FlowGraph(props) {
  if (!isFeatureRecipe(props.state)) return h(GenericGraph, props);
  var t = props.t, s = props.state, sel = props.selected;
  var n = nodesOf(s), latest = n.latest;
  var decisionNode = s.status === "needs_decision" ? { state: "decision" } : (s.resumed || latest.requirements) ? { state: "done" } : { state: "pending" };
  var reviewerRoles = Object.keys(latest).filter(function (r) { return /^r\d+$/.test(r); }).sort();
  var L = layoutGraph(latest, reviewerRoles, props.showDone);
  var pos = L.pos;
  var stateOf = function (role) { return role === "decision" ? decisionNode.state : nodeState(latest[role]); };
  var edgesList = [["setup", "analysis"], ["analysis", "decision"], ["decision", "requirements"], ["requirements", "draft"], ["draft", "dreview"], ["dreview", "plan"], ["plan", "implement"]];
  L.reviewers.forEach(function (r) { edgesList.push(["implement", r]); edgesList.push([r, "aggregate"]); });
  edgesList.push(["aggregate", "validate"]);
  var est = function (a, b) { var sa = stateOf(a), sb = stateOf(b); if (sb === "active") return "active"; if (sb === "failed" && sa !== "pending") return "failed"; if (sa === "done" && sb !== "pending") return "done"; return ""; };
  var path = function (a, b) { var A = pos[a], B = pos[b]; var ax = A.x + A.w / 2, ay = A.y + NH, bx = B.x + B.w / 2, by = B.y; return ax === bx ? "M" + ax + " " + ay + "V" + (by - 6) : "M" + ax + " " + ay + "V" + (by - 22) + "H" + bx + "V" + (by - 6); };
  var paths = edgesList.filter(function (e) { return pos[e[0]] && pos[e[1]]; }).map(function (e) { var c = est(e[0], e[1]); return h("path", { key: e.join(">"), className: cls("ars-edge", c), d: path(e[0], e[1]), markerEnd: "url(#ars-ah-" + (c || "idle") + ")" }); });
  var rounds = codeRounds(s), backCode = rounds > 1, ab = s.status === "aborted";
  var bcls = backCode ? (ab ? "failed" : "warn") : "";
  var labels = [];
  if (pos.draft && pos.dreview) {
    paths.push(h("path", { key: "back-d", className: "ars-edge back", d: "M" + NX + " " + (pos.dreview.y + NH / 2) + "H" + (NX - 30) + "V" + (pos.draft.y + NH / 2) + "H" + (NX - 6), markerEnd: "url(#ars-ah-idle)" }));
    labels.push(h("span", { key: "l-d", className: "ars-elbl", style: { left: NX - 30, top: (pos.dreview.y + pos.draft.y) / 2 + NH / 2 } }, t("reject")));
  }
  paths.push(h("path", { key: "back-c", className: cls("ars-edge back", bcls), d: "M" + NX + " " + (pos.aggregate.y + NH / 2) + "H36V" + (pos.implement.y + NH / 2) + "H" + (NX - 6), markerEnd: "url(#ars-ah-" + (bcls || "idle") + ")" }));
  labels.push(h("span", { key: "l-c", className: cls("ars-elbl", backCode ? (ab ? "bad" : "warn") : ""), style: { left: (36 + NX) / 2 - 2, top: pos.implement.y + NH / 2 - 15 } }, backCode ? (ab ? t("reject3", { n: rounds }) : t("repair", { n: rounds - 1 })) : t("reject")));
  labels.push(h("span", { key: "l-p", className: "ars-elbl", style: { left: CX, top: pos[L.reviewers[0]].y - 22 } }, t("parallel")));

  var group = function (ids, stageIds, left, width) {
    var shown = ids.filter(function (id) { return pos[id]; });
    if (!shown.length) return null;
    var top = Math.min.apply(null, shown.map(function (id) { return pos[id].y; })) - 22;
    var bottom = Math.max.apply(null, shown.map(function (id) { return pos[id].y; })) + NH + 18;
    return h("div", { key: "g-" + stageIds.join("+"), className: "ars-group", "data-hl": stageIds.indexOf(props.hlStage) >= 0, style: { left: left, top: top, width: width, height: bottom - top } },
      h("span", { className: "ars-glbl" }, h("span", { className: "ars-stag" }, stageIds.map(function (x) { return t("stage." + x); }).join(" + ")), " · " + t("loop")));
  };
  var markers = [["idle", "var(--ars-line-strong)"], ["done", "var(--ars-ok-line)"], ["active", "var(--ars-run)"], ["failed", "var(--ars-bad)"], ["warn", "var(--ars-warn)"]].map(function (m) {
    return h("marker", { key: m[0], id: "ars-ah-" + m[0], viewBox: "0 0 10 10", refX: 7, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
      h("path", { d: "M1 1l7 4-7 4", fill: "none", stroke: m[1], strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }));
  });
  var order = ["setup", "analysis", "decision", "requirements", "draft", "dreview", "plan", "implement"].concat(L.reviewers, ["aggregate", "validate"]);
  var nodes = order.filter(function (r) { return pos[r]; }).map(function (role) {
    var a = latest[role], state = stateOf(role), p = pos[role];
    var chips = [];
    if (a && a.verdict === "ok") chips.push(h("span", { key: "v", className: "ars-chip ok" }, t("verdict.ok")));
    if (a && a.verdict === "no") chips.push(h("span", { key: "v", className: "ars-chip no" }, t("verdict.no")));
    if (role === "decision" && state === "decision") chips.push(h("span", { key: "q", className: "ars-chip wait" }, String(s.decision.questions.length)));
    if (a && a.round > 1) chips.push(h("span", { key: "r", className: "ars-chip" }, "×" + a.round));
    if (a && a.tier && p.w === NW) chips.push(h("span", { key: "t", className: cls("ars-chip", "tier-" + a.tier) }, a.tier));
    if (a && a.model) chips.push(h("span", { key: "m", className: "ars-chip model" }, shortModel(a.model)));
    var time = a ? (a.outcome === undefined ? fmt(props.now - (a.startedAt || props.now)) : a.endedAt && a.startedAt ? fmt(a.endedAt - a.startedAt) : "") : "";
    return h("button", { key: role, type: "button", className: "ars-fnode", "data-role": role, "data-state": state, "aria-pressed": sel === role,
      style: { left: p.x, top: p.y, width: p.w, height: NH }, "aria-label": nodeTitle(t, role) + ": " + t("state." + state),
      onClick: function () { props.onSelect(sel === role ? null : role); },
      onKeyDown: function (e) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          var list = e.currentTarget.parentNode.querySelectorAll(".ars-fnode");
          var idx = Array.prototype.indexOf.call(list, e.currentTarget) + (e.key === "ArrowDown" ? 1 : -1);
          if (list[idx]) list[idx].focus();
        } else if (e.key === "Escape") props.onSelect(null);
      } },
      h("span", { className: "ars-ico", "aria-hidden": true }, h(NodeIcon, { role: role }), h("span", { className: "ars-st" }, ST_ICON[state] ? h(Icon, { name: ST_ICON[state], w: 3, size: 9 }) : null)),
      h("span", { className: "ars-t" }, nodeTitle(t, role)),
      h("span", { className: "ars-time" }, time),
      h("span", { className: "ars-chips" }, chips));
  });
  return h("div", { className: "ars-graph" },
    h("div", { className: "ars-legend" }, ["done", "active", "decision", "failed", "pending"].map(function (k) { return h("span", { key: k }, h("i", { className: "lg-" + k }), t("legend." + k)); })),
    L.hiddenCount || props.showDone ? h("button", { type: "button", className: "ars-collapsed", "aria-expanded": !!props.showDone, onClick: props.onToggleDone },
      h(Icon, { name: "check" }), props.showDone ? t("done.hide") : t("done.n", { label: steps(t, L.hiddenCount) }), h("span", { className: "ars-chev" }, h(Icon, { name: "chev" }))) : null,
    // The canvas keeps its absolute 520px layout; the viewport scrolls horizontally when narrower.
    h("div", { className: "ars-flow-scroll", dir: "ltr" }, h("div", { className: "ars-flow", style: { height: L.H } },
      [group(["draft", "dreview"], ["design"], NX - 60, NW + 94), group(["implement"].concat(L.reviewers, ["aggregate"]), ["build", "review"], 6, GW - 12)],
      h("svg", { className: "ars-edges", viewBox: "0 0 " + GW + " " + L.H, "aria-hidden": true }, h("defs", null, markers), paths),
      labels, nodes)));
}

function DetailPanel(props) {
  var t = props.t, role = props.role;
  if (!role) return h("div", { className: "ars-detail" }, h("div", { className: "ars-detail-empty" }, t("detail.empty")));
  var n = nodesOf(props.state), a = n.latest[role], hist = n.history[role] || [];
  var state = role === "decision" ? (props.state.status === "needs_decision" ? "decision" : "done") : nodeState(a);
  var rows = [[t("detail.stage"), stageTitle(t, selectedStage(props.state, role))], [t("detail.state"), t("state." + state)]];
  if (a && a.tier) rows.push([t("detail.tier"), ltr(a.tier)]);
  if (a && a.model) rows.push([t("detail.model"), ltr(shortModel(a.model))]);
  if (a && a.round) rows.push([t("detail.round"), t("detail.rounds", { n: a.round })]);
  if (a && a.endedAt && a.startedAt) rows.push([t("detail.duration"), ltr(fmt(a.endedAt - a.startedAt))]);
  var findings = a && a.findings && a.findings.length ? a.findings : [];
  var running = a && a.outcome === undefined;
  return h("div", { className: "ars-detail" },
    h("div", { className: "ars-dhead" }, h("span", { className: "ars-ico" }, h(NodeIcon, { role: role })),
      h("div", null, h("h4", null, a ? agentTitle(t, a) : nodeTitle(t, role)), a ? h("div", { className: "ars-dsub" }, ltr(a.label)) : null),
      h("button", { type: "button", className: "ars-iconbtn", "aria-label": t("close"), onClick: function () { props.onSelect(null); } }, h(Icon, { name: "close" }))),
    h("dl", { className: "ars-kv" }, rows.map(function (r, i) { return [h("dt", { key: "k" + i }, r[0]), h("dd", { key: "v" + i }, r[1])]; })),
    a && a.summary ? h("p", { className: "ars-summary" }, a.summary) : null,
    findings.length ? h("ul", { className: "ars-findings" }, findings.map(function (f, i) { return h("li", { key: i }, h("span", { className: "ars-sev" }, String(f.severity).toUpperCase()), h("span", null, f.problem)); })) : null,
    hist.length > 1 ? h("div", { className: "ars-hist" }, hist.map(function (x) { return h("button", { key: x.seq, type: "button", className: "ars-chip", onClick: function () { props.openSession(x.childId); } }, "#" + x.round + (x.verdict ? " · " + t("verdict." + x.verdict) : "")); })) : null,
    a && a.childId ? h("div", { className: "ars-dactions" },
      h("button", { type: "button", className: cls("ars-btn", running ? "primary" : ""), onClick: function () { props.openSession(a.childId); } }, h(Icon, { name: running ? "open" : "doc" }), running ? t("open.session") : t("read.session"))) : null);
}

// ───────────────────────── panel (keyed renderer) ─────────────────────────
function RecipeRunPanel(props) {
  var node = props.node, t = props.t, s = node.data;
  var openPair = useState(false), graphOpen = openPair[0], setGraphOpen = openPair[1];
  var selPair = useState(null), sel = selPair[0], setSel = selPair[1];
  var hlPair = useState(null), hl = hlPair[0], setHl = hlPair[1];
  var donePair = useState(false), showDone = donePair[0], setShowDone = donePair[1];
  var allPair = useState(false), showAll = allPair[0], setShowAll = allPair[1];
  var live = s.status === "running";
  var now = useNow(live);
  var stages = useMemo(function () { return stagesOf(s); }, [s]);
  var head = headline(s);
  var running = runningAgents(s);
  var finished = s.agents.filter(function (a) { return a.outcome !== undefined; });
  var lastRoundFailed = s.agents.filter(function (a) { return a.verdict === "no" && a.outcome !== undefined; });
  var shownAgents = showAll ? s.agents : running.concat(head === "repair" ? lastRoundFailed.filter(function (a) { return /^r\d+$/.test(a.role); }).slice(-3) : []);
  var openSession = function (id) { if (props.openSession) props.openSession(id); };
  var pending = props.useSessionStatus ? props.useSessionStatus(function(snapshot) { var status = snapshot.get(props.sessionId); return status && status.pendingInteraction; }) : null;
  var decidedForYou = s.decision ? s.decision.decidedForYou : [];
  var question = matchingQuestion(pending, props.sessionId, s.runId, s.decision ? s.decision.questions : [], decidedForYou);
  // Hook presence is fixed per mount (injected once), so this conditional call is stable.
  var liveLocale = props.useLocaleId ? props.useLocaleId() : undefined;
  var dir = cardDir(props.localeId !== undefined ? props.localeId : liveLocale, typeof document === "undefined" ? undefined : document);
  var canAnswer = !!question;
  var onAnswer = async function (answers) {
    if (!question) throw new Error('This decision is not currently pending.');
    // Answers EVERY pending id: untouched optional decidedForYou override questions send KEEP_DECISION (never display text).
    var batch = answerBatch(s.runId, s.decision.questions, answers, { pendingIds: (question.questions || []).map(function (q) { return q.id; }), decidedForYou: decidedForYou });
    await question.answer(batch); // canonical Host question response; never touch draft or attachments
  };
  var onStage = function (id) { setHl(id); setGraphOpen(true); setShowDone(true);
    var roles = nodeKeysForStage(s, id); var lt = nodesOf(s).latest;
    var pick = roles.filter(function (r) { var st = r === "decision" ? (s.status === "needs_decision" ? "decision" : "done") : nodeState(lt[r]); return st === "active" || st === "failed" || st === "decision"; })[0] || roles[roles.length - 1];
    setSel(pick); };
  var total = s.startedAt ? fmt((s.endedAt || now) - s.startedAt) : "";
  var r = s.result || {};
  var foot = [h("span", { key: "tot", className: "ars-total" }, h(Icon, { name: "clock", size: 12 }), total), h("span", { key: "n" }, t("foot.agents", { n: s.agents.length }))];
  if (r.changedPaths && r.changedPaths.length) foot.push(h("span", { key: "ch" }, t("foot.changed", { files: r.changedPaths.slice(0, 3).join("، ") + (r.changedPaths.length > 3 ? "…" : "") })));
  var result = null;
  if (s.status === "completed" && r.passed) result = h("span", { className: "ars-result ok" }, t("foot.passed", { p: r.passed }));
  else if (s.status === "completed_with_failures" && r.passed) result = h("span", { className: "ars-result bad" }, t("foot.passed", { p: r.passed }));
  else if (s.status === "ended") result = h("span", { className: "ars-result" }, t("foot.ended"));
  else if (s.status === "aborted") result = h("span", { className: "ars-result bad" }, t("foot.aborted", { n: codeRounds(s) }));
  else if (s.status === "error") result = h("span", { className: "ars-result bad" }, t("foot.error", { e: r.error || "" }));
  else if (s.status === "cancelled") result = h("span", { className: "ars-result bad" }, t("foot.cancelled"));

  useEffect(function () {
    if (!graphOpen) return undefined;
    var onKey = function (e) { if (e.key === "Escape" && !sel) setGraphOpen(false); };
    document.addEventListener("keydown", onKey);
    return function () { document.removeEventListener("keydown", onKey); };
  }, [graphOpen, sel]);

  var title = isFeatureRecipe(s) ? t('title') : s.title || s.recipe;
  return h("section", { className: "ars-card", dir: dir, "data-status": s.status, "aria-label": title },
    h("header", { className: "ars-head" },
      h("span", { className: "ars-recipe-icon", "aria-hidden": true }, h(Icon, { name: "pipeline", size: 16 })),
      h("div", { className: "ars-title" }, h("div", { className: "ars-name" }, title), h("div", { className: "ars-meta" }, s.task, " · ", ltr(s.recipe))),
      h("span", { className: cls("ars-pill", head) }, h("span", { className: "ars-pd", "aria-hidden": true }), t("pill." + head)),
      h("button", { type: "button", className: "ars-iconbtn", "aria-expanded": graphOpen, onClick: function () { setGraphOpen(!graphOpen); } }, h(Icon, { name: "expand" }), t("graph"))),
    h(StageStrip, { t: t, stages: stages, state: s, onStage: onStage }),
    s.status === "needs_decision" && s.decision ? h(DecisionBox, { key: s.decision.resumeId, t: t, decision: s.decision, runId: s.runId, onAnswer: onAnswer, canAnswer: canAnswer }) : null,
    shownAgents.length || finished.length ? h("div", { className: "ars-section" },
      shownAgents.length ? h("div", { className: "ars-section-title" }, running.length ? t("running.now") : t("agents")) : null,
      h("div", { className: "ars-agents" }, shownAgents.map(function (a) { return h(AgentRow, { key: a.seq, agent: a, t: t, now: now, openSession: openSession }); })),
      finished.length ? h("button", { type: "button", className: "ars-more", onClick: function () { setShowAll(!showAll); } },
        showAll ? t("agents.hide") : running.length ? t("agents.more", { n: finished.length }) : t("agents.all", { n: finished.length })) : null) : null,
    graphOpen ? h("div", { className: "ars-drawer" },
      h("div", { className: "ars-drawer-head" }, h("h3", null, t("graph.title")), h("span", { className: "ars-kbd" }, t("kbd")),
        h("button", { type: "button", className: "ars-iconbtn", "aria-label": t("close"), onClick: function () { setGraphOpen(false); } }, h(Icon, { name: "close" }))),
      h("div", { className: "ars-drawer-body" },
        h(FlowGraph, { t: t, state: s, now: now, selected: sel, hlStage: hl, showDone: showDone, onToggleDone: function () { setShowDone(!showDone); },
          onSelect: function (role) { setSel(role); setHl(role ? selectedStage(s, role) : null); } }),
        h(DetailPanel, { t: t, state: s, role: sel, openSession: openSession, onSelect: function (role) { setSel(role); setHl(role ? selectedStage(s, role) : null); } }))) : null,
    h("footer", { className: "ars-foot" }, foot, result));
}

/*@@CSS@@*/

function ensureCss() {
  if (typeof document === "undefined" || document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) return;
  var tag = document.createElement("style");
  tag.dataset.plugin = "dsh-auto-subagents";
  tag.dataset.pluginCss = CSS_ID;
  tag.textContent = CARD_CSS;
  document.head.appendChild(tag);
}

/*@@SETTINGS@@*/

var inject = ["uiConversation", "slots", "sessions", "locale", "configForms", "remote", "remote.session", "uiWorkspace"];
function apply(ctx) {
  ensureCss();
  registerAutoSettings(ctx);
  ctx.effect(function () { return ctx.uiConversation.events.register(definition); }, "auto-subagents: conversation events");
  // zh deliberately reuses the English copy (no Chinese translation yet); do not machine-invent one.
  ctx.effect(function () { return ctx.locale.register(NS, { ar: en, en: en, zh: en }); }, "auto-subagents: dictionaries");
  var locale = ctx.locale;
  var readLocale = function () { try { var snap = locale.getSnapshot ? locale.getSnapshot() : locale.getLocale(); return snap && snap.active; } catch (e) { return undefined; } };
  var subscribeLocale = function (fn) { return locale.subscribe ? locale.subscribe(fn) : function () {}; };
  var useLocaleId = function () { return React.useSyncExternalStore ? React.useSyncExternalStore(subscribeLocale, readLocale, readLocale) : readLocale(); };
  ctx.slots.inject("conversation.chat.node", function () {
    return ctx.slots.register({
      name: "conversation.chat.node", key: KIND, locale: NS,
      inject: function () { return { useLocaleId: useLocaleId, openSession: function (id) { ctx.uiWorkspace.openSession(id); } }; }
    }, RecipeRunPanel);
  });
}
var name = "dsh-auto-subagents";
exports.apply = apply;
exports.inject = inject;
exports.name = name;
exports.__test = { definition: definition, RecipeRunPanel: RecipeRunPanel, layoutGraph: layoutGraph, FlowGraph: FlowGraph, AutoSettings: AutoSettings, optionKey: optionKey, RecipeCanvas: RecipeCanvas, setRecipeEntry: setRecipeEntry, setRoleOverride: setRoleOverride, recipeOverridesInvalid: recipeOverridesInvalid };
