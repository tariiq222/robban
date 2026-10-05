/** Auto host entry: validates Session support and exposes its browser module. */
import { assertAutoSessionSupport } from './compatibility.mjs';
export const name = 'dsh-auto-subagents';
export const inject = [];
/** Report bundle activation without registering agent-scoped behavior on the Host. */
export function apply(ctx) {
  assertAutoSessionSupport();
  ctx.logger?.info?.('Auto Subagents host loaded');
}
