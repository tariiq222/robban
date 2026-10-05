---
name: design-dependencies
version: 1
---

# Design and dependencies

Use only the current phase's authorized scope and capabilities. Planning produces a proposal; it does not authorize implementation or dispatch.

Identify the requested outcomes, retained invariants and deliberate behavior changes before choosing structure. Trace current producers, consumers and ownership. Distinguish a source-supported design choice from an assumption about runtime behavior or a missing user decision. Prefer the smallest change that satisfies the existing requirements without inventing public operations or speculative abstractions.

Define cohesive work packages by observable outcome and concrete files. For each package identify both read inputs and write outputs, acceptance evidence and dependencies. New files can be proposed explicitly; existing scripts and interfaces require inspected source evidence.

Disjoint write scopes establish only the absence of direct write collisions. A reader of another package's changed contract, generated artifact or test result depends on that producer even when it writes elsewhere. Explain the direction and reason for serialization. Check transitive dependencies and cycles; ensure every original goal has a responsible package.

Compare before and after behavior, including error handling, cancellation and persistence when relevant. Record unresolved inputs or contract decisions as limitations rather than assuming they are safe. A valid dependency graph is a planning result, not proof that the implementation or verification succeeded.
