#!/usr/bin/env node
// Read-only report. No default session path: caller must explicitly supply a file.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { flowTiming } from '../lib/flow-timing.mjs';
async function decompress(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('zstd', ['-dc', '--', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [], errors = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`zstd exited ${code}: ${Buffer.concat(errors).toString('utf8').trim()}`)));
  });
}
export async function readEvents(file) {
  let text;
  if (/\.(zstd|zst)$/.test(file)) {
    try { text = await decompress(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Plain JSONL still works without zstd, including misleading suffixes.
      text = await readFile(file, 'utf8');
      if (text.includes('\u0000')) throw new Error('Compressed input requires the zstd executable; supply plain JSONL instead.');
    }
  } else text = await readFile(file, 'utf8');
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at line ${index + 1}; compressed input requires zstd.`); }
  });
}
const ms = value => `${(value / 1000).toFixed(3)}s`;
export async function main(argv, out = console.log) {
  if (argv.length !== 1) throw new Error('usage: node scripts/flow-report.mjs SESSION.jsonl[.zstd]');
  const runs = flowTiming(await readEvents(argv[0]));
  out('Run\tWall\tCritical\tAgents\tAgent work\tStatus');
  for (const run of runs) {
    out(`${run.runId}\t${ms(run.wallClockMs)}\t${ms(run.criticalPathMs)}\t${run.agentCount}\t${ms(run.agentDurationMs)}\t${run.status}`);
    out('  Stage\tAgent work\tActive wall\tAgents');
    for (const stage of run.stages) out(`  ${stage.stage}\t${ms(stage.durationMs)}\t${ms(stage.wallClockMs)}\t${stage.agentCount}`);
    out('  Role / provider / model\tAgent work\tAgents');
    for (const role of run.roleModels) out(`  ${role.role} / ${role.provider} / ${role.model}\t${ms(role.durationMs)}\t${role.agentCount}`);
  }
  return runs;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
