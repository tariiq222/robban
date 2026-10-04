// Display-only stage graph of each approved recipe, used by the settings canvas.
// Each stage id is a meta phase title; roles are the routed roles the script marks in that phase.
// test/recipe-flows.test.mjs keeps this map aligned with the approved scripts and metadata.
import { effectiveRoleTable, STRICT_BUILTIN_ROLES, WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES } from './recipe-contract.mjs';

const stage = (id, roles, extra = {}) => Object.freeze({ id, roles: Object.freeze(roles), ...extra });

/** Ordered stages per recipe; `loop` marks a repeat-until-approved stage, `parallel` concurrent workers. */
export const RECIPE_FLOWS = Object.freeze({
  'feature-pipeline': Object.freeze([
    stage('setup', ['setup']),
    stage('analysis', ['analysis']),
    stage('requirements', ['requirements']),
    stage('design-loop', ['design', 'designReview'], { loop: true }),
    stage('plan', ['plan']),
    stage('code-loop', ['implementer', 'reviewer', 'aggregate'], { loop: true, parallel: true }),
    stage('validate', ['validate']),
  ]),
  'bug-fix': Object.freeze([
    stage('setup', ['setup']),
    stage('analysis', ['analysis']),
    stage('code-loop', ['implementer', 'reviewer'], { loop: true, parallel: true }),
    stage('validate', ['validate']),
  ]),
  refactor: Object.freeze([
    stage('setup', ['setup']),
    stage('analysis', ['analysis']),
    stage('baseline', ['baseline']),
    stage('code-loop', ['implementer', 'reviewer'], { loop: true, parallel: true }),
    stage('validate', ['validate']),
  ]),
  'code-audit': Object.freeze([
    stage('scope', ['audit-scanner']),
    stage('scans', ['audit-scanner'], { parallel: true }),
    stage('verify', ['audit-checker']),
  ]),
  investigate: Object.freeze([
    stage('scope', ['investigator']),
    stage('gather', ['investigator']),
    stage('check', ['investigation-checker']),
  ]),
  'plan-to-packages': Object.freeze([
    stage('evidence', ['planner']),
    stage('packages', ['planner']),
    stage('check', ['package-checker']),
  ]),
  'qa-verify': Object.freeze([
    stage('analysis', ['qa-verifier']),
    stage('verify', ['qa-verifier']),
    stage('check', ['qa-checker']),
  ]),
});

/** Roles whose tier is fixed to strong by the recipe contract. */
export const STRONG_LOCKED_ROLES = Object.freeze([...new Set([...STRICT_BUILTIN_ROLES, 'validate'])]);

const BOOLEAN_ARG = /^boolean\b/;
const ARG_DEFAULT = /default (true|false)/;

/**
 * Boolean recipe options documented in `meta.args` as `boolean, default <value>; ...`.
 * @param {object} meta  approved recipe metadata
 * @returns {{key: string, default: boolean, detail: string}[]}
 */
export function booleanOptions(meta) {
  return Object.entries(meta?.args ?? {})
    .filter(([, detail]) => typeof detail === 'string' && BOOLEAN_ARG.test(detail))
    .map(([key, detail]) => ({ key, default: ARG_DEFAULT.exec(detail)?.[1] === 'true', detail }));
}

/**
 * Settings catalog embedded in the browser bundle: stages, effective role tiers and options.
 * @param {Record<string, object>} metas  approved metadata keyed by recipe name
 * @returns {object[]} one entry per recipe that has a flow, in name order
 */
export function recipeSettingsCatalog(metas) {
  return Object.keys(metas).filter(name => Object.hasOwn(RECIPE_FLOWS, name)).sort().map(name => {
    const meta = metas[name];
    const table = effectiveRoleTable(WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES, meta.roles || {});
    const stages = RECIPE_FLOWS[name].map(s => ({ ...s, roles: [...s.roles],
      detail: (meta.phases || []).find(p => p.title === s.id)?.detail ?? '' }));
    const roles = [...new Set(stages.flatMap(s => s.roles))].map(role => ({
      role, tier: table[role].tier, locked: STRONG_LOCKED_ROLES.includes(role) }));
    return { name, description: meta.description ?? '', whenToUse: meta.whenToUse ?? '', stages, roles, options: booleanOptions(meta) };
  });
}
