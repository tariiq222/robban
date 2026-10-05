# code-audit — saved source-only audit

## Purpose and status

An actual saved recipe for evidence-backed source review, not an implementation recipe. It creates a report and changes no repository files. Independent review passed after closing an uncovered-verification finding; the captain created and checked `recipe.lock.json` against the final metadata/script bytes. No live-model run or live Web activation is claimed.

Use it for bounded correctness/security reviews or a named change area. Required arguments: nonblank `task`, absolute canonical POSIX `repo`. No resume or human decisions are required because the task is source-only. Credentials, commands, browsers, network, editing, runtime tests, commits and delegation are out of scope.

## Three phases

1. **scope** — identify up to40 concrete repository-relative files and direct source context. Partial requested coverage is recorded, never silently treated as complete.
2. **scans** — launch two independent bounded scans in parallel: security/input/permission/data flows, and correctness/contracts/edge cases/test gaps. Each reads selected source and reports findings plus actual claimed file coverage.
3. **verify** — a separate evidence-checking child reads the source and resolves every union finding exactly once as `verified`, `dismissed` or `unknown`.

Custom roles `audit-scanner` and `audit-checker` both require strong-tier routing and allow bounded read-only retries. They do not use the canonical `reviewer` role, which requires a published implementer. The script emits authenticated role markers with `readOnly:true`; the host must enforce the agreed read/glob/grep/structured_output allowlist. Without the updated host policy, prompt text alone does not enforce read-only. A missing routing token is supported only for direct/offline hook execution, whose caller owns tool restrictions.

## Deterministic output and gates

The result contains `status`, `summary`, `findings`, `dismissed`, `coverage`, `limitations`, `reviewTrail`, and `changedPaths:[]`.

- `completed` means the bounded report passed accounting/coverage gates; it **never certifies code clean**. A completed report may contain high/blocker findings.
- `completed_with_failures` means incomplete/unknown coverage, failed or malformed child results, bad references, or unresolved candidates.
- Original candidate severity/evidence/location is retained. Final confidence and verification evidence are explicit.
- Local scanner ids are not global identities. Exact location/title/evidence duplicates merge source evidence, preserving the highest severity and all source recommendations. Different evidence or locations remain separate even when local ids collide.
- Every candidate receives a deterministic global id. Verification must resolve exactly that set, once each: missing, duplicate, extra or malformed resolutions retain all candidates unverified and dismiss none.
- A verified/dismissed resolution needs reason, source evidence, confidence0..1, and declared inspection of the finding's file. A high finding cannot disappear silently: dismissed candidates stay visible in `dismissed` with reason/evidence.
- Empty findings are accepted only with explicit nonempty selected scope, full declared source coverage and independent verification coverage. Source line references require selected relative files and positive safe integer lines; the recipe cannot independently prove an LLM actually read the source or that cited lines exist. Independent evidence checking and honest limitations are still essential.

No imports or unsupported agent options are used in the sandbox body. Only `agent`, `parallel`, `phase`, `log`, `args` and JSON-compatible schema objects are needed. Four successful child stages are sufficient: scope, two scans, verifier; no hidden repair loop.

## Test evidence

Source plan: direct delegated implementation contract. User journey: obtain a source audit without modifications and with candidate verification accounted for, rather than a fabricated clean verdict.

Runner from plugin directory:

```sh
/Users/tariq/.local/share/deepseek-harness/node-v24.21.0-darwin-arm64/bin/node --test test/code-audit-recipe.test.mjs
```

The tests execute the **actual saved script** through AsyncFunction with fake hooks and actual installed `assertObjectJsonSchema` / `validateJsonSchemaValue`. No LLM or target-repository side effects occur.

- Initial incomplete-feature RED before recipe files existed:37 tests,0pass,37fail,exit1 (missing source/meta, not a preexisting defect reproducer).
- Initial implementation GREEN:37/37 pass,exit0.
- Additional meaningful coverage hardening RED:43tests,42pass,1fail,exit1; verifier was able to dismiss a finding while reporting no inspection of its file. Fixed by deterministic candidate-file coverage gate before accepting resolutions.
- Final expanded GREEN after adding explicit uncovered verified/dismissed assertions:44tests,44pass,0fail/cancelled/skipped/todo,exit0 (runner duration82.839625ms). Independent review subsequently passed; the captain approved and verified the final lock.

Tests cover empty/sorted findings, safe duplicate merge, visible dismissal, exact verifier accounting, source references, invalid task/repo, null/malformed/exception stages, incomplete coverage, parallel starts, marker/custom-role/read-only flags, object-schema compatibility and unsupported-option exclusion. Coverage percentage for AsyncFunction source is not claimed.

## Known limits

This is static source review, not exploit reproduction, tests, runtime acceptance or release readiness. Scanner/checker model separation uses host routing and is not asserted as canonical implementer/reviewer independence. The current static feature-pipeline card may display legacy unused stages for this recipe until dynamic cards ship; the returned report and phase events are the authoritative results. Live UI and real models were not tested. The saved approval lock now permits discovery/execution with the updated host; live activation remains unverified.
