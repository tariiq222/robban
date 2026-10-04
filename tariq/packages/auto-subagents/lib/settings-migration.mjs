/** Pure conversion of the legacy subagent-model-selection section to Auto config fields. */
import { MODEL_TIERS, routeKey } from './router.mjs';

function records(value, label, tiered = false) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  return value.map(entry => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.provider !== 'string' || !entry.provider.length
      || typeof entry.model !== 'string' || !entry.model.length) {
      throw new Error(`${label} requires non-empty provider and model ids`);
    }
    const key = routeKey(entry);
    if (seen.has(key)) throw new Error(`${label} repeats route ${entry.provider}/${entry.model}`);
    seen.add(key);
    if (tiered && !MODEL_TIERS.includes(entry.tier)) throw new Error(`modelTiers tier must be ${MODEL_TIERS.join(', ')}`);
    return { provider: entry.provider, model: entry.model, ...(tiered ? { tier: entry.tier } : {}) };
  });
}

/**
 * Validate and copy legacy settings without reading or writing a settings document.
 * @param section - Legacy section with enabled, allowedModels, and optional modelTiers.
 * @returns Detached Auto config fields for the auto-model-selection entry. Empty authorization stays empty.
 */
export function migrateLegacyModelSelection(section) {
  if (section === null || typeof section !== 'object' || Array.isArray(section)
    || typeof section.enabled !== 'boolean') throw new Error('Auto model settings require an enabled boolean');
  return {
    enabled: section.enabled,
    allowedModels: records(section.allowedModels, 'allowedModels'),
    modelTiers: records(section.modelTiers === undefined ? [] : section.modelTiers, 'modelTiers', true),
  };
}
