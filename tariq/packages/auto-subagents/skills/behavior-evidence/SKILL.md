---
name: behavior-evidence
version: 1
---

# Behavior evidence

Apply this method only within the current phase's allowed tools and scope. It grants no additional capabilities or work.

Start from the requested behavior, its explicit acceptance and the observed state. Cite inspected source locations for source observations. Separate those observations from assumptions about inputs, scheduling, environment and external systems. A source proposition can be supported without establishing the cause of a runtime incident.

For a hypothesis, identify a competing explanation and a concrete observation that would distinguish them. Describe what would disprove the favored explanation. Preserve uncertainty where required evidence is unavailable. Confidence is a judgment about the stated proposition, not a calibrated probability of correctness.

For permitted runtime verification, connect each acceptance item or preserved invariant to the specific observation and existing authorized command that checks it. Preserve the command, exit status, relevant output and environment limitations. Passing unrelated tests does not establish acceptance. A failure to prepare the environment is blocked evidence, not a product defect or permission to repair setup.

For behavioral repairs, distinguish evidence before the change from evidence afterward. For refactors, compare the same externally visible invariants before and after. A source-only phase proposes discriminating checks; it never claims it executed them.
