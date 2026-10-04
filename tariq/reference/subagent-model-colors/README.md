# Local subagent model badges

## What changed

Installed bundle: `/Users/tariq/.local/share/deepseek-harness/runtime/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js`.

- Each healthy catalog row now displays the exact request-used model ID, with a deterministic model-specific color.
- Provider/model is available in the tooltip and row accessible name.
- Color depends only on model ID, not provider, row order, activity or reasoning effort. The hash-derived hue is not a uniqueness guarantee for every possible string.
- Colors have distinct light/dark foreground values and opaque explicit badge backgrounds.
- Existing activity dots, navigation, token metrics and durations remain intact.
- Uses `summary.projectionValues.modelSelection.lastUsed`, not pending `next` selection or parent defaults. If no model has been used/projected yet, no model is invented and the badge is omitted.
- No routing, automatic delegation, server logic or active sessions were changed.

## Installation and refresh

The installed client bundle has already been patched directly. This installation contains published artifacts, not a source checkout: no `apps/web` or build toolchain is available there. The browser plugin bundle is the actual deliverable, so a shell rebuild is not needed for this local patch. No `pnpm run dev:web` watcher was running and automatic refresh is not promised.

Refresh the existing DSH page after active work safely finishes. If the previous bundle remains, restart the existing `dsh web` process only when active work is finished. The module host keeps bundle bytes in memory; its HMR rehash mechanism can update them, but serving the new revision has **not** been authenticated/verified here. No replacement server was started and no server was restarted.

Updates/reinstalls may overwrite this local change. The patch and original backup live outside node_modules. To reapply the exact matching version:

```sh
node /Users/tariq/.local/share/deepseek-harness/local-changes/subagent-model-colors/apply.mjs
```

The script is idempotent and refuses to overwrite an unknown upstream version. `client.original.js` is the original backup, and `client.patched.js` is the patched artifact. DSH version inspected: `0.1.5-rc.2`.

## Test evidence

Journey: identify the executing model for each subagent without confusing model identity with running status.

RED: `node --test model-badge.test.mjs` executed seven tests against the original installed bundle; seven failed because identity/color helpers and the visible badge did not exist. Two earlier test-harness attempts failed during setup and do not count as RED evidence.

GREEN: `node --test --experimental-test-coverage model-badge.test.mjs` passed all eight final tests. `node --check` passed for the installed client bundle. `node apply.mjs` reports `Model badges already applied.`

| Guarantee | Type | Result |
| --- | --- | --- |
| Last-used model wins over unconsumed next selection | Unit | PASS |
| Missing/malformed/never-used model data invents no badge | Unit | PASS |
| Model colors are deterministic | Unit | PASS |
| Five representative model IDs receive distinct foreground colors | Unit | PASS |
| Foreground/background contrast is at least 4.5:1 for 100 sampled model IDs in both declared themes | Unit | PASS |
| Catalog render includes model ID, provider tooltip, accessible name and existing ongoing dot | Render-contract | PASS |
| Projection changes produce a new model badge | Render-contract | PASS |
| Missing model leaves a focusable/navigable row | Render-contract | PASS |

Tests run the actual installed bundle factory in a VM with JSX-element mocks. They test the row render contract, not a mounted React DOM or the authenticated application. The Node coverage report covers the test harness only; **production coverage percentage is not verified**, and no 80% production-coverage claim is made.

## Verification limits

- `http://127.0.0.1:3080` responds, but the independent browser receives `dsh web authentication required; reopen the URL printed by dsh web.`
- The Chrome bridge is not connected. Authenticated refresh, live catalog visibility, real provider routing/fallback, keyboard interaction, narrow viewport layout and custom themes remain **Not verified**.
- No git checkpoint commits: this installed runtime directory is not a git repository.
- Existing server, jobs and subagents were not interrupted.

## Self-evaluation

| Axis | Score | Evidence / improvement |
| --- | --- | --- |
| Accuracy | 4/5 | Eight tests pass against installed code; authenticated delivery of the changed bundle remains unverified. |
| Completeness | 3/5 | Identity/color behavior is implemented; visual verification in the user's authenticated session is still required. |
| Clarity | 4/5 | Exact model ID and provider tooltip are present; small-panel clipping is not browser-tested. |
| Actionability | 4/5 | Installed patch, backup and guarded reapply script are available; refresh/restart timing depends on active work. |
| Conciseness | 4/5 | Production change is limited to one UI bundle; local artifact copies exist solely for safe reapplication. |

Overall: 3.8/5. Highest-impact follow-up: verify the refreshed authenticated DSH catalog in light/dark and narrow viewports. Would the user agree? Likely only after seeing the badge in their live session; implementation alone is not proof of live delivery.
