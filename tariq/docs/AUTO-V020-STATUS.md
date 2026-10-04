# Auto integration on DSH 0.2.1-alpha.1

## Current state

Auto `0.4.0-dev.0` is integrated with `dsh-v0.2.1-alpha.1` for the local `master` branch. The original baseline is retained at the `robban-baseline-0.1.5-backup` tag. Personal settings and the installed 0.1.5 runtime have not been migrated. No remote push or live provider request is part of this acceptance.

The integration replaces six installed routing/settings/UI patches with Auto-owned delegation, live model settings and a settings editor. Two source changes remain necessary: ignorable Session append metadata and the request-preparation recovery event. The preset retains the newer Standard time-context and scheduling capability, including its child-agent scheduling deny list. The bundle registers its preset declaratively, uses PTC for workflows, initializes routing through `agent/created`, reads canonical tool messages and resolves declared package dependencies. Historical compiled patches are retained as evidence; their command-line application is disabled on this target.

## Verification

| Surface | Evidence |
|---|---|
| Target build | Host and Client TypeScript project builds, both tsdown passes, and `pnpm run build:web` passed on Node 24.21.0 after merging the newer master. Desktop packaging was not tested. |
| Auto package | 747 tests passed, zero failures/skips, with target-built packages. Covers routing, delegation, receipts, card rendering, all seven recipe bodies, real PTC execution, cancellation and single-use resume. |
| Engine | 65 focused Session append, request-preparation recovery and agent-loop regression tests passed after the merge. The newer master removes the old generated scope invariant files. |
| TypeScript SDK | The scheduler-recovery snapshot was refreshed to a v4 successor and replay passed through `dsh --profile sdk`. The committed v3 Session remains intact. |
| Python SDK | `sdk-recovery` refreshed and replayed with Python 3.11 against the built `dsh` CLI and a local scripted provider. This is not single-executable packaging acceptance. |
| Browser / Loader | Isolated Web booted at port 3181. Auto appears in the preset menu and can be selected. Its settings page renders, saves a model tier and retains it after reload. Auto uses English copy inside the installed bundle page; full application localization is deferred. |
| Recipe integrity | All 21 metadata/script/lock files match the preserved seven-recipe baseline byte-for-byte. |
| Review | Separate read-only engine and Auto reviews completed. Removed client navigation APIs, locale registration and preview dotenv isolation findings were corrected. |
| Documentation | Initial doc-sync passed 38 of 43 gates. Type equivalence, graph freshness, budgets and repository references were repaired and checked separately. English-only Robban README files still fail upstream bilingual pairing. The global rule remains enabled. |

Master integration logs are local under `/tmp/robban-master-*`; earlier migration logs remain under `/tmp/robban-v020-*`; the preview screenshot is `.artifacts/auto-migration/auto-settings.png`. These paths contain disposable verification evidence, not portable test dependencies.

## Run locally

Use Node 24 or newer. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build
node tariq/packages/auto-subagents/build.mjs
node tariq/scripts/auto-preview.mjs
```

The launcher stores preview data under `.artifacts/auto-home`, defaults to port 3181, strips provider environment variables and refuses local dotenv or credential files. It uses the seven approved repository recipes. Auto routing starts disabled; browser verification saved one tier in this disposable profile without making a model request.

## Remaining acceptance

- A complete provider-backed Auto journey, including spawn/fork execution, actual model labels, human answer-and-resume, stop/retry and reopening the run card, requires separately authorized provider access.
- The current UI is the existing run card plus functional English Auto settings; Robban-specific product design and desktop packaging remain later stages.
- The standalone plugin still requires the two source engine extensions; it cannot claim compatibility with unmodified upstream.
- Private Robban READMEs are English by user request. The upstream Chinese-pair requirement remains a documentation policy decision before public release.
- Historical reference files contain installation-specific paths. They are not executed by the new plugin; review them before public publication.

The routing measurement receipt is incomplete: the coordinator baseline was late and the local receipt ledger rejected participant attachment. Whole-task tokens and subscription savings remain unknown.
