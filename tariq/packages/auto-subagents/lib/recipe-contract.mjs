// Pure plugin-owned metadata contract. This describes routing/retry, not tool permissions.
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const RESERVED_ROLE_NAMES = Object.freeze(['__proto__', 'constructor', 'prototype']);
export const TIERS = Object.freeze(['light', 'medium', 'strong']);
export const LIMITS = Object.freeze({ maxWhenToUse: 500, maxRoles: 32 });
/** Default tier per built-in workflow role. */
export const WORKFLOW_ROLE_TIERS = Object.freeze({
  setup: 'light', analysis: 'medium', requirements: 'medium', design: 'medium',
  designReview: 'strong', plan: 'medium', implementer: 'strong', reviewer: 'strong',
  aggregate: 'medium', validate: 'strong',
});
// Roles whose retry is safe: they do not edit the repository. `implementer` is opt-in.
export const READ_ONLY_RETRY_ROLES = new Set(['setup', 'analysis', 'requirements', 'design', 'designReview', 'plan', 'reviewer', 'aggregate', 'validate']);
export const STRICT_BUILTIN_ROLES = Object.freeze(['reviewer', 'implementer']);
const STRONG_BUILTIN_ROLES = Object.freeze(['implementer', 'reviewer', 'validate']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function normalizeRoles(roles) {
  if (!plain(roles)) throw new Error('recipe roles must be a plain object');
  const keys = Object.keys(roles);
  if (keys.length > LIMITS.maxRoles) throw new Error(`recipe roles exceed ${LIMITS.maxRoles}`);
  const normalized = Object.create(null);
  for (const role of keys) {
    if ((role !== 'designReview' && !ROLE_NAME_PATTERN.test(role)) || RESERVED_ROLE_NAMES.includes(role)) throw new Error(`invalid recipe role name "${role}"`);
    const descriptor = roles[role];
    if (!plain(descriptor) || Object.keys(descriptor).some(key => !['tier', 'readOnlyRetry'].includes(key))) throw new Error(`invalid recipe role descriptor "${role}"`);
    if (!Object.hasOwn(descriptor, 'tier') || !TIERS.includes(descriptor.tier)
      || (STRONG_BUILTIN_ROLES.includes(role) && descriptor.tier !== 'strong')) throw new Error(`invalid recipe role tier "${role}"`);
    const hasRetry = Object.hasOwn(descriptor, 'readOnlyRetry');
    if (hasRetry && (typeof descriptor.readOnlyRetry !== 'boolean' || STRICT_BUILTIN_ROLES.includes(role))) throw new Error(`invalid recipe readOnlyRetry "${role}"`);
    normalized[role] = Object.freeze({ tier: descriptor.tier, ...(hasRetry ? { readOnlyRetry: descriptor.readOnlyRetry } : {}) });
  }
  return Object.freeze(normalized);
}

export function validateRecipeMeta(meta, { name } = {}) {
  if (!plain(meta)) throw new Error('recipe metadata must be a plain object');
  if (typeof meta.name !== 'string' || !meta.name.trim() || meta.name !== name) throw new Error(`recipe "${name}" meta.name is "${meta.name}"`);
  let whenToUse;
  if (Object.hasOwn(meta, 'whenToUse')) {
    if (typeof meta.whenToUse !== 'string' || !meta.whenToUse.trim() || meta.whenToUse.trim().length > LIMITS.maxWhenToUse) throw new Error(`recipe whenToUse must be a non-empty string of at most ${LIMITS.maxWhenToUse} characters`);
    whenToUse = meta.whenToUse.trim();
  }
  const roles = normalizeRoles(Object.hasOwn(meta, 'roles') ? meta.roles : {});
  return Object.freeze({ roles, ...(whenToUse === undefined ? {} : { whenToUse }) });
}

export function effectiveRoleTable(globalTiers, readOnlyRetrySet, recipeRoles = {}) {
  const roles = normalizeRoles(recipeRoles);
  const table = Object.create(null);
  for (const [role, tier] of Object.entries(globalTiers)) {
    if (!TIERS.includes(tier)) throw new Error(`invalid recipe role tier "${role}"`);
    table[role] = Object.freeze({ tier, readOnlyRetry: readOnlyRetrySet.has(role) });
  }
  for (const [role, descriptor] of Object.entries(roles)) {
    table[role] = Object.freeze({ tier: descriptor.tier, readOnlyRetry: Object.hasOwn(descriptor, 'readOnlyRetry') ? descriptor.readOnlyRetry : table[role]?.readOnlyRetry ?? false });
  }
  return Object.freeze(table);
}
