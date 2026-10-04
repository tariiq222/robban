/** Host singleton exposing live Auto authorization and model tiers through volatile config. */
import { runtimeModuleUrl } from './dsh-paths.mjs';
import { migrateLegacyModelSelection } from './settings-migration.mjs';
const { Service } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { default: z } = await import(runtimeModuleUrl('@deepseek-ai/schemastery'));

const routeFields = { provider: z.string().min(1).required(), model: z.string().min(1).required() };
export const name = 'auto-model-selection';

/** Settings identity shared by delegation, recovery, recipes, and the settings editor. */
export class AutoModelSelection extends Service {
  static Config = z.object({
    enabled: z.boolean().default(false).volatile(),
    allowedModels: z.array(z.object(routeFields)).default([]).volatile(),
    modelTiers: z.array(z.object({ ...routeFields, tier: z.union(['light', 'medium', 'strong']).required() })).default([]).volatile(),
    // Per-recipe tuning keyed by recipe name; run_recipe validates it against the approved recipe.
    recipeOverrides: z.dict(z.object({
      disabled: z.boolean(),
      roles: z.dict(z.object({ tier: z.union(['light', 'medium', 'strong']), timeoutMinutes: z.natural().min(1).max(240) })),
      args: z.dict(z.boolean()),
    })).default({}).volatile(),
  });

  constructor(ctx, config) {
    super(ctx, 'subagentModelSelection');
    this.config = config;
    this.current();
  }

  /**
   * Read the current saved preference; malformed route assignments fail admission.
   * @returns Detached authorization and tier lists in saved priority order.
   */
  current() {
    return migrateLegacyModelSelection({
      enabled: this.config.enabled.get(),
      allowedModels: this.config.allowedModels.get(),
      modelTiers: this.config.modelTiers.get(),
    });
  }

  /**
   * Read the saved per-recipe settings.
   * @returns Detached overrides keyed by recipe name; empty when nothing is saved.
   */
  recipeOverrides() {
    return structuredClone(this.config.recipeOverrides?.get() ?? {});
  }
}
export default AutoModelSelection;
