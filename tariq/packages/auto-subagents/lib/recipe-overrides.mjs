// Saved per-recipe settings applied by run_recipe on top of the approved files.
// Overrides never edit a recipe, so its approval lock stays valid; they only change
// routing tiers, step timeouts, enablement and documented boolean options.
import { effectiveRoleTable, TIERS, WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES } from './recipe-contract.mjs';
import { STRONG_LOCKED_ROLES, booleanOptions } from './recipe-flows.mjs';

const MAX_TIMEOUT_MINUTES = 240;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Resolve the saved overrides of one recipe against its approved contract.
 * Throws on an override the recipe cannot honor, so a stale or invalid setting fails the run loudly.
 * @param {object} saved  `recipeOverrides` setting keyed by recipe name
 * @param {string} name  recipe name
 * @param {object} meta  approved recipe metadata
 * @param {object} recipeRoles  normalized roles from the approved contract
 * @returns {{disabled: boolean, roles: object, timeouts: Record<string, number>, args: Record<string, boolean>}}
 *   `roles` extends `recipeRoles` for routing; `timeouts` are per-role milliseconds.
 */
export function resolveRecipeOverrides(saved, name, meta, recipeRoles) {
  const entry = plain(saved) && Object.hasOwn(saved, name) ? saved[name] : undefined;
  const roles = { ...recipeRoles };
  const timeouts = {};
  const args = {};
  if (!plain(entry)) return { disabled: false, roles, timeouts, args };
  const table = effectiveRoleTable(WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES, recipeRoles);
  for (const [role, override] of Object.entries(plain(entry.roles) ? entry.roles : {})) {
    if (!Object.hasOwn(table, role)) throw new Error(`recipe "${name}" settings name unknown role "${role}"`);
    if (!plain(override)) continue;
    if (override.tier !== undefined) {
      if (!TIERS.includes(override.tier)) throw new Error(`recipe "${name}" role "${role}" has invalid tier "${override.tier}"`);
      if (STRONG_LOCKED_ROLES.includes(role) && override.tier !== 'strong') throw new Error(`recipe "${name}" role "${role}" must stay strong`);
      roles[role] = { ...(Object.hasOwn(recipeRoles, role) ? recipeRoles[role] : {}), tier: override.tier };
    }
    if (override.timeoutMinutes !== undefined) {
      const minutes = override.timeoutMinutes;
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_TIMEOUT_MINUTES) throw new Error(`recipe "${name}" role "${role}" timeout must be 1-${MAX_TIMEOUT_MINUTES} minutes`);
      timeouts[role] = minutes * 60_000;
    }
  }
  const allowed = booleanOptions(meta).map(option => option.key);
  for (const [key, value] of Object.entries(plain(entry.args) ? entry.args : {})) {
    if (!allowed.includes(key) || typeof value !== 'boolean') throw new Error(`recipe "${name}" settings name unsupported option "${key}"`);
    args[key] = value;
  }
  return { disabled: entry.disabled === true, roles, timeouts, args };
}
