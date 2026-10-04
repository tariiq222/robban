# Verification record

## 0.3.0 (current source; live activation not verified)

### Follow-up: real engine metadata compatibility

- The user observed a live `META_INVALID` failure before any child started: `meta.version` and `meta.args` are not recognized by the installed worker-thread engine. Previous offline run_recipe tests used a mock engine that omitted this validation; their passing results did not cover the actual engine boundary.
- The new test/recipe-engine-meta.test.mjs reproduced that exact error before the fix: 3 failed, 1 passed. After a narrow metadata projection at the start call, all 4 passed. Tests invoke the real installed validateMeta and, in one case, the actual WorkerThreadWorkflowEngine.start plus a worker thread and a fake schema-producing child provider. Invalid supported field values still fail. Extended metadata remains intact and integrity-checked.
- Final follow-up verification: 315/315 tests; build/syntax passed; approved recipe unchanged and check passed; core patches 12/12; preset tests 4/4. An independent Claude review passed 4/4 and confirmed the validator/worker are real rather than mocked.
- This follow-up is implemented locally but requires another explicitly approved restart to replace the cached server module. It is not a real-model feature run and does not prove end-to-end live acceptance.

- Core speedups, structured-output fallback and per-step timeout enforcement are implemented on disk. This does not establish that the existing live Web process has loaded them.
- Final captain verification after integrating replacement-admission timeout hardening: 311/311 tests passed in the installed source directory, and 311/311 passed again from an isolated copied package with a temporary DSH_HOME and copied approved recipe. Client build and syntax check passed, the exact feature-pipeline approval lock matched, all 12 core patches were applied, and the preset suite passed 4/4. package.json and package-lock.json both identify 0.3.0.
- Replacement-admission hardening has three RED→GREEN tests: expiry stops the step waiting even when the provider ignores cancellation, releases its reservation immediately, and disposes a late-published child exactly once. Disposal still awaits tracked pending publication for cleanup; a permanently non-cooperative provider can therefore still delay final disposal.
- Final command evidence is recorded in /tmp/dsh-0.3.0-final-suite.log, /tmp/dsh-0.3.0-portable-suite.log, /tmp/dsh-0.3.0-patches.log and /tmp/dsh-0.3.0-preset.log (temporary logs, not durable release artifacts).
- Independent focused reviews: setup cache 5/5; routing 46/46; fast-path/validation review passed behaviorally (its temporary integrity failure preceded the final recipe approval).
- Ten new regression tests were mutation-proven in isolated copied package/recipe layouts. M3 fails when only the latest implementer route is excluded after failure memory expires. M11 sticky validation fails on a repaired round with distinguishable or missing early validation; unconditional retention also fails with unapproved continuation. Empty/directory/glob scope and cache key/permissions mutants fail their respective behavioral assertions. Copies were re-approved so the integrity gate did not mask the test assertions.
- The package and package lock identify version 0.3.0. The future-state map describes proposed additional recipes, not implemented ones.
- No fresh full real-model acceptance run or measured end-to-end speedup is claimed for 0.3.0.

### Self-evaluation of the 0.3.0 delivery

| Axis | Score | Evidence / improvement |
|---|---|---|
| Accuracy | 4/5 | 311/311 tests in place and in a portable copy, exact recipe approval and 12/12 patch check. No fresh live-model acceptance run is claimed. |
| Completeness | 4/5 | All eight approved speedup items are implemented. Live activation and end-to-end performance measurement remain separate acceptance steps. |
| Clarity | 4/5 | Source version, proposed recipes and activation limits are distinguished here; older historical evidence is retained and needs careful reading. |
| Actionability | 4/5 | Approved recipe and passing checks support restart readiness, but restart requires current user confirmation and must avoid interrupting active work. |
| Conciseness | 4/5 | Evidence is consolidated here; the long conversation contains repetitive progress notices rather than one concise execution summary. |

Overall: 4.0/5. Highest-value next improvements: (1) safely activate with user confirmation, (2) run a fixture with real models and verify outputs, (3) measure stage durations before/after instead of estimating speed gains. Self-check: the user can verify the completed disk changes, but should not regard offline tests as proof of live performance.

## 0.2.0 (historical packaging evidence)

The packaging checks below were collected during the 0.2.0 hardening pass; they are retained as attributed historical evidence.

### Packaging evidence (lane 4)

- **Preset resolution.** `dsh-agent-presets` classifies a non-absolute, non-relative row `name` as a package and imports it with the Loader's internal resolver from the host composition base (`ctx.baseUrl` = profile directory, set by `dsh-app-boot`). Checked with the roster's own `scanRoot` against a copy of the preset using `dsh-auto-subagents/{runtime,coordinator,recipes}`: healthy from `profiles/web/`, broken from `profiles/headless/` (no dependency there), and a deliberately misspelled name is reported broken. `import.meta.resolve` from the profile base yields `plugins-src/dsh-auto-subagents/lib/*.mjs`, the same realpath as before, and the shims export identical objects (`automaticRouter` etc. — one module instance). The live preset was then switched (backup: `agent.cordis.yml.bak-before-package-names`); roster scan of `home/.agent-presets` reports all presets ok; preset test 4/4.
- **Core patches.** 12 targets. All 12 originals are byte-identical to `npm pack @deepseek-ai/<pkg>@0.1.5-rc.2` (8 also matched the older `local-changes` backups; 4 companions — scope invariant, tool-cordis metadata, agent runtime-types, tool-subagent types — had no backup and were recovered from npm). Patched copies = current runtime files (and equal to `local-changes/*.patched.*` where those exist). `npm run check:core-patches` against the real runtime: **all 12 applied**, exit 0. `--apply` was NOT run against the real runtime; it is covered by `test/core-patches.test.mjs` on a temp runtime (apply+backup+idempotence, refuse on drift with no partial write, refuse on tampered patch bytes, shipped manifest self-consistency).
- **React for render tests** installed as devDependencies (18.3.1, same as the former `/tmp/ars-test`).
- No server restart, no process killed, no commit.

## 0.1.0 (historical — numbers below predate 0.2.0 and are not re-verified)

### Tests run

- `npm test`: 183/183 passed (all current tests plus legacy routing/coordinator tests).
- Auto preset: `node --test auto-subagents.test.mjs`: 4/4 passed.
- `node --check lib/client.js`: passed.
- Earlier full coverage run (179 tests): 97.89% lines, 81.23% branches, 92.70% functions of loaded Node modules. This does NOT attribute the AsyncFunction recipe body or VM/browser UI; no whole-product coverage claim.
- Recipe-gate TDD: 21 failures before fixes; additional regression 1 failure; final 33/33 passed. Guarantees: reviewer failure/rejection/high findings fail closed, findings cannot be erased, validation covers exact acceptance set, design choices stop immediately, cumulative answers survive resumes.
- Resume TDD: missing validateResume export failed; 3/3 passed after implementation. Added owner, exact contract, complete answers, consumed-token and scoped file freshness + atomic claim defenses.
- Terminal UI reconciliation: 1 failure (orphan agent remained active after error), passed after fix; another RED/GREEN verified resumed analysis displays as reused/done.
- Final independent review found a stale-reader resume claim race. Regression failed before fix; claim now reloads persisted state while holding the lock.

### Live DSH browser evidence

Throwaway DSH instance at port 3096, copied home `/tmp/ars-install-home`, test-only `ars-replay` plugin (NOT installed in production):
- Actual `auto-recipe/*` durable events rendered chat cards.
- Live rejection → implement #2 update displayed repair state.
- Reviewer details showed high findings and actual recorded model.
- Completion showed Validation 13/13.
- Reload restored two cards from session history.
- Browser page errors: zero.
- Canonical question test: real Host `ask_user_question` tool → real `PendingQuestion` → card called `answer()` once → Host logged `ANSWER_ACCEPTED`. No composer draft/attachments were touched by the card.
- Historical decision button remained disabled after reload (no matching live question).
- Test evidence session id: `session-58db3905-28c5-434c-9f7e-865c4a56a2d9` in the throwaway home.

This run replayed engine events through the same RunTracker without real LLM calls.

## Known limits

- Core runtime patches are still required (now shipped and checked by the package); the `tool-subagent` patch imports the router through the `home/local-plugins` shim by absolute path.
- Native spawn starts before returning a handle; routing adoption occurs on publication and reconciles early fallback.
- Graph expands inside the chat card rather than a DSH sidebar pane.
- No fresh real-model `run_recipe` run has been recorded after packaging.
- Activation of changed server modules requires a safe, user-chosen restart of the existing `dsh web`.
