// Resolve React for render tests: PKG's own node_modules first, then REACT_DIR, then /tmp/ars-test.
// Never silently skip: if none is available the import throws with an actionable message.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const candidates = [
  { from: 'package node_modules', req: () => createRequire(import.meta.url) },
  ...(process.env.REACT_DIR ? [{ from: `REACT_DIR=${process.env.REACT_DIR}`, req: () => createRequire(`${process.env.REACT_DIR}/package.json`) }] : []),
  ...(existsSync('/tmp/ars-test/package.json') ? [{ from: '/tmp/ars-test', req: () => createRequire('/tmp/ars-test/package.json') }] : []),
];
const tried = [];
let found;
for (const c of candidates) {
  try { const req = c.req(); found = { React: req('react'), server: req('react-dom/server'), from: c.from }; break; }
  catch (error) { tried.push(`${c.from}: ${error.code ?? error.message}`); }
}
if (!found) throw new Error(`React render tests need react + react-dom. Install them as devDependencies of this package (npm install), or set REACT_DIR to a directory containing them. Tried: ${tried.join('; ') || 'no candidates'}`);
export const React = found.React;
export const { renderToStaticMarkup } = found.server;
export const reactSource = found.from;
