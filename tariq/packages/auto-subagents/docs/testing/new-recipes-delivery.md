# Saved code-audit and bug-fix delivery

## Delivered scope

Actual saved recipes under `DSH_HOME/recipes/code-audit/` and `DSH_HOME/recipes/bug-fix/`, each with `meta.json`, plain sandbox `script.js`, README, and an approval lock after independent review. Existing feature-pipeline bytes/lock are unchanged. No installs, commits, server restart, deployment or live-model workflow runs.

- code-audit: bounded source scope → parallel security/correctness scans → evidence checker → deterministic severity-ranked report. Report completion is not a clean-code certification. All children request code-enforced read-only tools.
- bug-fix: source diagnosis → explicit human choices if needed → executed assertion/behavior regression RED before production → same-command GREEN/full verification → two independently routed reviewers → fresh exact final validation. Maximum three implementation attempts across decision resumes.

## Necessary host integration

`lib/workflow-routing.mjs` now accepts only a boolean `readOnly` field in an authenticated approved-recipe marker. True narrows the original and replacement request/descriptor to a fixed host-owned allowlist: read, read_image, glob, grep, structured_output. Existing caller restrictions are intersected; malformed filters and providers without filter capability fail closed. No bash/write/edit/browser/network/delegation or future unknown tools are admitted. Existing unmarked recipes keep prior behavior. This is not a general permission-framework rewrite.

`test/recipe-readonly.test.mjs` covers admission/replacement, restriction intersection, invalid flag/filter, descriptor parity and actual installed tool registry composition including nested execution and late-added tools. The initial three dispatch regressions were RED before production edits; registry fixture setup errors were corrected separately, not represented as RED evidence.

## Verification

Working directory: installed plugin source. Runner: supplied Node v24.21.0.

- `node --test test/*.test.mjs test/legacy/*.test.mjs`: **497 tests, 497 pass, 0 fail/cancelled/skipped/todo**, exit 0; runner duration 1191.452708 ms.
- code-audit actual-source tests: **44/44**. Independent review passed after closing a high uncovered-file dismissal defect; both verified and dismissed resolutions now need checker coverage of the candidate file.
- bug-fix actual-source tests: **46/46**. Three independent review findings addressed: classified genuinely executed RED, scope gate before decision persistence, retained feedback/history and total attempt budget across resume. Additional diagnosis-test path scope RED→GREEN recorded in its README.
- `test/new-recipes-worker.test.mjs`: actual saved script bodies run through actual `run_recipe` metadata projection and installed worker-thread engine using deterministic fake schema providers, **2/2 pass**. No LLMs or target-repository writes. Initial fixture failures caused by assuming stripped private marker labels were fixed in test code only.
- Independent audit/host/routing review suite: **123/123** before two additional readonly test cases were added; no outstanding audit/host findings.

Tests validate schemas and execute actual recipe bodies, not substitute implementations. Source-only AsyncFunction test counts are not proof of real-model success or whole-product coverage.

## Review and approval state

- code-audit: independent PASS, final metadata/script approved and checked.
- bug-fix: final independent PASS, 46/46 tests plus separate dependency/scope/resume probes. Final metadata/script approved and lock checked. Approved-only discovery returns exactly `["bug-fix","code-audit","feature-pipeline"]`; all three locks match, and feature-pipeline remains unchanged.

## Known limits

Already-running Web modules/catalog registrations may be stale until a safe user-approved restart. Live UI/model acceptance remains unverified. The visual card is still feature-pipeline-shaped and can show unused stages for these recipes; structured reports and phase events are authoritative. Source evidence and reported changed paths cannot mechanically prove actual LLM reads or all filesystem writes. Bug-fix reviewers/validator need shell verification and their no-edit constraint is prompt-only; safe commands require actual script inspection. Symlink write containment and arbitrary-shell security are not claimed. Audit scanner/checker model identity separation is not claimed as canonical implementer/reviewer independence.

## Self-check

Accuracy 4/5: offline engine/tests and independent review, no live activation claim. Completeness 4/5: actual recipe files, tests and locks; live acceptance deliberately separate. Clarity 4/5: saved versus loaded state explicit; legacy visual card may confuse users. Actionability 4/5: ready saved recipe usage; restart/live check requires separate consent. Conciseness 4/5: evidence consolidated, detailed per-recipe READMEs retain RED history. Overall 4.0/5; highest-impact follow-up is one user-authorized bounded live acceptance per recipe, then dynamic-card work only if requested.
