/**
 * dsh-rtl-arabic — DSH web plugin: automatic RTL for Arabic text.
 *
 * Contributes one `<style>` and one bootstrap `<script>` row to the served
 * index.html through the webserver's `index-inject` table (the same mechanism
 * the built-in theme plugin uses). The browser script watches the DOM and gives
 * every text block whose content is predominantly Arabic `dir="rtl"`, so it is
 * right-aligned and laid out by the Unicode bidi algorithm; Latin-dominant
 * blocks stay left-aligned and neutral blocks inherit. Code blocks (`pre`),
 * KaTeX and syntax-highlighted output are never touched; editable fields
 * (textarea / contenteditable) get `dir="auto"` so typing Arabic right-aligns
 * live while typing English stays left-aligned.
 *
 * Decisions are per block (paragraph / heading / list item / cell), which is
 * the standard "per-paragraph auto direction" behavior users expect from chat
 * apps: mixed Arabic/English messages keep every paragraph on its natural side.
 */

const STYLE_RULES = [
	"/* dsh-rtl-arabic: IBM Plex Sans Arabic for every Arabic glyph in the app —",
	" * the whole UI inherits its font from body via --dsw-font-family, so appending",
	" * IBM to the variable covers the composer, session titles, todos, settings, ... */",
	":root { --dsw-font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Helvetica Neue\", Helvetica, Arial, sans-serif, \"IBM Plex Sans Arabic\" !important; }",
	"/* dsh-rtl-arabic: automatic RTL for Arabic-dominant blocks */",
	"[dir=\"rtl\"] { text-align: start; }",
	"li[dir=\"rtl\"] { list-style-position: inside; }",
	"li[dir=\"rtl\"] > ul, li[dir=\"rtl\"] > ol { padding-left: 0; padding-right: 1.4em; }",
	"li[dir=\"rtl\"] input[type=\"checkbox\"] { margin: 0 0 0 8px; }",
	"blockquote[dir=\"rtl\"] { border-left-color: transparent; border-right: 2px solid var(--dsw-alias-label-caption, rgba(128,128,128,.6)); padding-left: 0; padding-right: 14px; }",
	"[dir=\"rtl\"] :not(pre) > code { unicode-bidi: isolate; }",
	"/* dsh-rtl-arabic: Arabic-dominant paragraphs render fully in IBM Plex (specificity beats the app's font shorthands) */",
	"[dir=\"rtl\"] { font-family: \"IBM Plex Sans Arabic\", var(--dsw-font-family, -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Helvetica Neue\", Helvetica, Arial, sans-serif); }",
	"[class*=\"_markdown_\"] [dir=\"rtl\"] { font-family: \"IBM Plex Sans Arabic\", var(--dsw-font-family, -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Helvetica Neue\", Helvetica, Arial, sans-serif); }",
	"textarea[dir=\"auto\"], [contenteditable=\"true\"][dir=\"auto\"] { font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Helvetica Neue\", Helvetica, Arial, sans-serif), \"IBM Plex Sans Arabic\"; }",
].join("\n");

/* Self-hosted IBM Plex Sans Arabic (SIL OFL) served from /assets/fonts/ — generated from the
 * Google Fonts css2 API; arabic + latin subsets, weights 400/500/600/700. Injected by build. */
const FONT_CSS = "@font-face {\n  font-family: 'IBM Plex Sans Arabic';\n  font-style: normal;\n  font-weight: 400;\n  font-display: swap;\n  src: url(/assets/fonts/dsh-rtl-ibmplexsa-400-arabic.woff2) format('woff2');\n  unicode-range: U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC, U+102E0-102FB, U+10E60-10E7E, U+10EC2-10EC4, U+10EFC-10EFF, U+1EE00-1EE03, U+1EE05-1EE1F, U+1EE21-1EE22, U+1EE24, U+1EE27, U+1EE29-1EE32, U+1EE34-1EE37, U+1EE39, U+1EE3B, U+1EE42, U+1EE47, U+1EE49, U+1EE4B, U+1EE4D-1EE4F, U+1EE51-1EE52, U+1EE54, U+1EE57, U+1EE59, U+1EE5B, U+1EE5D, U+1EE5F, U+1EE61-1EE62, U+1EE64, U+1EE67-1EE6A, U+1EE6C-1EE72, U+1EE74-1EE77, U+1EE79-1EE7C, U+1EE7E, U+1EE80-1EE89, U+1EE8B-1EE9B, U+1EEA1-1EEA3, U+1EEA5-1EEA9, U+1EEAB-1EEBB, U+1EEF0-1EEF1;\n}\n@font-face {\n  font-family: 'IBM Plex Sans Arabic';\n  font-style: normal;\n  font-weight: 400;\n  font-display: swap;\n  src: url(/assets/fonts/dsh-rtl-ibmplexsa-400-latin.woff2) format('woff2');\n  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;\n}\n@font-face {\n  font-family: 'IBM Plex Sans Arabic';\n  font-style: normal;\n  font-weight: 500;\n  font-display: swap;\n  src: url(/assets/fonts/dsh-rtl-ibmplexsa-500-arabic.woff2) format('woff2');\n  unicode-range: U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC, U+102E0-102FB, U+10E60-10E7E, U+10EC2-10EC4, U+10EFC-10EFF, U+1EE00-1EE03, U+1EE05-1EE1F, U+1EE21-1EE22, U+1EE24, U+1EE27, U+1EE29-1EE32, U+1EE34-1EE37, U+1EE39, U+1EE3B, U+1EE42, U+1EE47, U+1EE49, U+1EE4B, U+1EE4D-1EE4F, U+1EE51-1EE52, U+1EE54, U+1EE57, U+1EE59, U+1EE5B, U+1EE5D, U+1EE5F, U+1EE61-1EE62, U+1EE64, U+1EE67-1EE6A, U+1EE6C-1EE72, U+1EE74-1EE77, U+1EE79-1EE7C, U+1EE7E, U+1EE80-1EE89, U+1EE8B-1EE9B, U+1EEA1-1EEA3, U+1EEA5-1EEA9, U+1EEAB-1EEBB, U+1EEF0-1EEF1;\n}\n@font-face {\n  font-family: 'IBM Plex Sans Arabic';\n  font-style: normal;\n  font-weight: 500;\n  font-display: swap;\n  src: url(/assets/fonts/dsh-rtl-ibmplexsa-500-latin.woff2) format('woff2');\n  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;\n}\n@font-face {\n  font-family: 'IBM Plex Sans Arabic';\n  font-style: normal;\n  font-weight: 600;\n  font-display: swap;\n  src: url(/assets/fonts/dsh-rtl-ibmplexsa-600-arabic.woff2) format('woff2');\n  unicode-range: U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC, U+102E0-102FB, U+10E60-10E7E, U+10EC2-10EC4, U+10EFC-10EFF, U+1EE00-1EE03, U+1EE05-1EE1F, U+1EE21-1EE22, U+1EE24, U+1EE27, U+1EE29-1EE32, U+1EE34-1EE37, U+1EE39, U+1EE3B, U+1EE42, U+1EE47, U+1EE49, U+1EE4B, U+1EE4D-1EE4F, U+1EE51-1EE52, U+1EE54, U+1EE57, U+1EE59, U+1EE5B, U+1EE5D, U+1EE5F, U+1EE61-1EE62, U+1EE64, U+1EE67-1EE6A, U+1EE6C-1EE72, U+1EE74-1EE77, U+1EE79-1EE7C, U+1EE7E, U+1EE80-1EE89, U+1EE8B-1EE9B, U+1EEA1-1EEA3, U+1EEA5-1EEA9, U+1EEAB-1EEBB, U+1EEF0-1EEF1;\n}\n@font-face {\n  font-family: 'IBM Plex Sans Arabic';\n  font-style: normal;\n  font-weight: 600;\n  font-display: swap;\n  src: url(/assets/fonts/dsh-rtl-ibmplexsa-600-latin.woff2) format('woff2');\n  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;\n}\n@font-face {\n  font-family: 'IBM Plex Sans Arabic';\n  font-style: normal;\n  font-weight: 700;\n  font-display: swap;\n  src: url(/assets/fonts/dsh-rtl-ibmplexsa-700-arabic.woff2) format('woff2');\n  unicode-range: U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC, U+102E0-102FB, U+10E60-10E7E, U+10EC2-10EC4, U+10EFC-10EFF, U+1EE00-1EE03, U+1EE05-1EE1F, U+1EE21-1EE22, U+1EE24, U+1EE27, U+1EE29-1EE32, U+1EE34-1EE37, U+1EE39, U+1EE3B, U+1EE42, U+1EE47, U+1EE49, U+1EE4B, U+1EE4D-1EE4F, U+1EE51-1EE52, U+1EE54, U+1EE57, U+1EE59, U+1EE5B, U+1EE5D, U+1EE5F, U+1EE61-1EE62, U+1EE64, U+1EE67-1EE6A, U+1EE6C-1EE72, U+1EE74-1EE77, U+1EE79-1EE7C, U+1EE7E, U+1EE80-1EE89, U+1EE8B-1EE9B, U+1EEA1-1EEA3, U+1EEA5-1EEA9, U+1EEAB-1EEBB, U+1EEF0-1EEF1;\n}\n@font-face {\n  font-family: 'IBM Plex Sans Arabic';\n  font-style: normal;\n  font-weight: 700;\n  font-display: swap;\n  src: url(/assets/fonts/dsh-rtl-ibmplexsa-700-latin.woff2) format('woff2');\n  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;\n}";

const SCRIPT = [
	"(function () {",
	'  "use strict";',
	"  if (window.__dshRtlArabic) return;",
	"  window.__dshRtlArabic = true;",
	'  var BLOCK = "p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,caption,figcaption,dd,dt,summary,table";',
	'  var SKIP = "pre,.katex,[contenteditable=true]";',
	"  var RE_RTL = /[\\u0590-\\u05FF\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]/g;",
	"  var RE_LTR = /[A-Za-z\\u00C0-\\u024F\\u0370-\\u03FF\\u0400-\\u04FF]/g;",
	"  function count(text, re) {",
	"    var n = 0;",
	'    text.replace(re, function () { n++; return ""; });',
	"    return n;",
	"  }",
	"  function directionOf(el) {",
	'    var text = el.textContent || "";',
	"    if (!text) return null;",
	"    var rtl = count(text, RE_RTL);",
	"    var ltr = count(text, RE_LTR);",
	'    if (rtl > 0 && rtl > ltr) return "rtl";',
	'    if (ltr > 0) return "ltr";',
	"    return null;",
	"  }",
	"  function process(el) {",
	"    if (el.closest && el.closest(SKIP)) return;",
	"    var dir = directionOf(el);",
	"    if (dir) {",
	'      if (el.getAttribute("dir") !== dir) el.setAttribute("dir", dir);',
	'      if (el.getAttribute("data-dsh-rtl") !== dir) el.setAttribute("data-dsh-rtl", dir);',
	"    } else {",
	'      if (el.hasAttribute("dir")) el.removeAttribute("dir");',
	'      if (el.hasAttribute("data-dsh-rtl")) el.removeAttribute("data-dsh-rtl");',
	"    }",
	"  }",
	"  function subtree(root) {",
	"    if (!root || root.nodeType !== 1) return;",
	"    if (root.matches && root.matches(BLOCK)) process(root);",
	"    var nodes = root.querySelectorAll(BLOCK);",
	"    for (var i = 0; i < nodes.length; i++) process(nodes[i]);",
	"  }",
	"  function inputs(root) {",
	"    if (!root || root.nodeType !== 1) return;",
	'    var editables = root.matches && root.matches("textarea,[contenteditable=true]") ? [root] : [];',
	'    var nodes = root.querySelectorAll ? root.querySelectorAll("textarea,[contenteditable=true]") : [];',
	"    for (var i = 0; i < nodes.length; i++) editables.push(nodes[i]);",
	"    for (var j = 0; j < editables.length; j++) {",
	'      if (editables[j].getAttribute("dir") !== "auto") editables[j].setAttribute("dir", "auto");',
	"    }",
	"  }",
	"  function nearestBlock(node) {",
	"    var el = node.nodeType === 1 ? node : node.parentElement;",
	"    while (el) {",
	"      if (el.matches && el.matches(BLOCK)) return el;",
	"      el = el.parentElement;",
	"    }",
	"    return null;",
	"  }",
	"  var queued = [];",
	"  var scheduled = false;",
	"  function schedule(nodes) {",
	"    for (var i = 0; i < nodes.length; i++) if (nodes[i]) queued.push(nodes[i]);",
	"    if (!scheduled && queued.length) {",
	"      scheduled = true;",
	"      (window.requestAnimationFrame || window.setTimeout)(run);",
	"    }",
	"  }",
	"  function run() {",
	"    scheduled = false;",
	"    var batch = queued;",
	"    queued = [];",
	"    for (var i = 0; i < batch.length; i++) {",
	"      var node = batch[i];",
	"      if (!node || !node.isConnected) continue;",
	"      try { subtree(node); inputs(node); } catch (e) {}",
	"    }",
	"    try { inputs(document.body); } catch (e) {}",
	"  }",
	"  var observer = new MutationObserver(function (mutations) {",
	"    var nodes = [];",
	"    for (var i = 0; i < mutations.length; i++) {",
	"      var m = mutations[i];",
	'      if (m.type === "childList") {',
	"        for (var j = 0; j < m.addedNodes.length; j++) {",
	"          var added = m.addedNodes[j];",
	"          if (added.nodeType === 1) nodes.push(added);",
	"          nodes.push(nearestBlock(added));",
	"        }",
	'      } else if (m.type === "characterData") {',
	"        nodes.push(nearestBlock(m.target));",
	'      } else if (m.type === "attributes" && m.attributeName === "dir") {',
	'        if (!m.target.hasAttribute("data-dsh-rtl")) nodes.push(m.target);',
	"      }",
	"    }",
	"    schedule(nodes);",
	"  });",
	"  function start() {",
	"    try { subtree(document.body); inputs(document.body); } catch (e) {}",
	'    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributeFilter: ["dir"] });',
	"  }",
	'  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);',
	"  else start();",
	"})();"
].join("\n");

/**
 * Register the index-injection rows.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 */
export function apply(ctx) {
	ctx.on("webserver/index-inject", (table) => {
		table.push({ kind: "style", text: FONT_CSS + "\n" + STYLE_RULES });
		table.push({ kind: "script", placement: "body", text: SCRIPT });
	});
}
