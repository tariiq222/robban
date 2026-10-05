#!/usr/bin/env node
/** Convert a copied legacy settings document into a new, unapplied Auto config overlay. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, JSON_SCHEMA } from 'js-yaml';
import { migrateLegacyModelSelection } from '../lib/settings-migration.mjs';

/**
 * Extract only Auto routing fields; unrelated settings never enter the output.
 * @param text - Copied legacy settings.yaml or settings.yaml.imported contents.
 * @returns A Cordis overlay targeting the installed Auto settings entry.
 */
export function settingsOverlay(text) {
  let document;
  try { document = load(text, { schema: JSON_SCHEMA }); }
  catch (_error) { throw new Error('Legacy settings must be valid YAML without executable tags'); }
  if (document === null || typeof document !== 'object' || Array.isArray(document)
    || !Object.hasOwn(document, 'subagent-model-selection')) {
    throw new Error('Legacy settings require a subagent-model-selection section');
  }
  return [{ id: 'auto-model-selection', config: migrateLegacyModelSelection(document['subagent-model-selection']) }];
}

/**
 * Create a reviewable overlay without applying it or overwriting any existing file.
 * @param argv - Explicit input and output paths, in that order.
 * @returns After a private output file is created; source data remains unchanged.
 */
export async function main(argv) {
  if (argv.length !== 2) throw new Error('usage: node scripts/migrate-settings.mjs COPIED_SETTINGS.yaml NEW_AUTO_PATCH.yml');
  const [input, output] = argv.map(file => path.resolve(file));
  const overlay = settingsOverlay(await readFile(input, 'utf8'));
  // JSON is valid YAML and preserves provider/model identifiers without executable tags.
  await writeFile(output, JSON.stringify(overlay, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
