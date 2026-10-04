# Auto recipes on DSH 0.2.0-rc.2

## Summary

Auto recipe integration fixtures use the public PTC workflow engine and Node process runtime. The seven saved recipe scripts and their approval locks remain unchanged. Runtime acceptance is pending the coordinator's build and integrated verification.

## Table of Contents

- [Runtime composition](#runtime-composition)
- [Focused acceptance](#focused-acceptance)
- [Limitations](#limitations)

## Runtime composition

The [test fixture](../test/helpers/ptc-runtime.mjs) mounts Cordis, Sessions, Session Projections, local filesystem and subprocess services, the local sandbox, Sandbox Policy, Node PTC Runtime, Subagent Runtime, and Workflow PTC. It uses the public package exports. The Node PTC runtime requires its built process entry as well as its main module. Tests use a private temporary workspace and dispose workflow runs and the owning Cordis context before removing it.

The child provider supplies deterministic offline answers. The workflow program itself executes in the real PTC process; no model provider is contacted. `run_recipe` registers a private routing provider for each invocation and passes its name through `subagentProvider`. The PTC engine resolves that provider before starting the program. Workflow metadata remains restricted to name, description, whenToUse and phases; approved recipe extensions stay in the recipe loader.

## Focused acceptance

The coordinator owns execution after building the declared target dependencies. The focused files are:

| Test | Evidence required |
|---|---|
| `recipe-engine-meta.test.mjs` | Metadata projection, a structured PTC child, cancellation cleanup, checkpoint resume and single-use consumption |
| `recipe-workspace.test.mjs` | Rejection before admission for invalid workspaces; real PTC execution for matching directories and symlink aliases |
| `new-recipes-worker.test.mjs` | All seven unchanged saved bodies through `run_recipe` and PTC, selected routes, read-only filters and private-provider removal |
| `seven-recipes-catalog.test.mjs` | Approval integrity, discovery and target metadata validation for all seven recipes |

The focused invocation from the package directory is `node --test test/recipe-engine-meta.test.mjs test/recipe-workspace.test.mjs test/new-recipes-worker.test.mjs test/seven-recipes-catalog.test.mjs`, with `DSH_AUTO_RECIPES_DIR` pointing to the copied recipe directory. Use the package's supported Node version and the coordinator's declared-package resolution setup. This command has not yet passed against the built target.

## Limitations

These fixtures exercise real PTC execution with scripted child answers. They do not establish real-model behavior, a live profile upgrade, physical sandbox enforcement in restrictive modes, or fresh-child structured-output recovery against the full in-process agent stack. The migration does not replace existing focused router and lifecycle tests.
