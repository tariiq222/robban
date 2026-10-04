/** Auto host entry: exposes its browser module; agent behavior belongs to the preset. */
export const name = 'dsh-auto-subagents';
export const inject = [];
/** Report bundle activation without registering agent-scoped behavior on the Host. */
export function apply(ctx) {
  ctx.logger?.info?.('Auto Subagents host loaded');
}
