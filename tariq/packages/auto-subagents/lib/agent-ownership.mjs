/** Live Agent ownership is distinct from the enclosing Cordis preset scope. */

/**
 * Detect delegated callers using durable classification and the live Agent registry.
 * @param {object} agent - The calling Agent supplied by the tool runtime.
 * @param {object} registry - The injected Agent registry; lightweight direct-call fixtures may omit it.
 * @returns {boolean} Whether the caller is a delegated child, including children without origin metadata.
 */
export function isDelegatedAgent(agent, registry) {
  const header = agent.session?.header;
  if (header?.origin === 'subagent' || Number(header?.delegationDepth) > 0 || agent.parentAgent) return true;
  if (registry?.roots && registry?.get && registry.get(agent.session.id) === agent) return !registry.roots().includes(agent);
  return Boolean(registry?.isOwnedBy && registry.list().some(owner => registry.isOwnedBy(agent.session.id, owner)));
}
