# Task memory and stage methods

## Continuing work

The Auto preset mounts `task_memory`. For substantive work the coordinator creates a task and keeps its returned `taskId` across turns. It saves concise progress, evidence references, decisions, blockers and next steps after milestones. When the user continues the same task in another session, the coordinator lists and reads the matching task, verifies current repository state and uses the same explicit id. Similar titles never automatically join tasks. Casual conversation does not need a task record.

`task_memory` supports create, list, read and append. Repository identity comes from the calling session's working directory and is canonicalized; model arguments cannot select another repository. Only a top-level agent can create or append. Read returns newest-first bounded pages with remaining-entry counts and an observed revision. Append requires that revision; a stale writer rereads before retrying. Notes retain their originating session ids.

The same tool defines and reads a durable subgoal/work-item plan, records blockers and reopens eligible work. Its graph revision is separate from the note revision. [Persistent work plans](TASK-WORK.md) defines dependencies, execution reservation, result handling and the bridge to existing DSH goals and todos.

Passing the optional `taskId` to `run_recipe` loads the existing task before admission, adds a bounded selection of historical notes to each child's logged prompt and records the outcome afterward. The outcome contains the run id, recipe, reported status, selected relative paths and next-step guidance. It excludes raw errors, human answers and resume tokens. If saving fails, the result reports `taskMemorySaved: false`; successful work must not be repeated merely to save a note. Calls without `taskId` retain their previous behavior.

Memory supplies context, never permission, verified human answers or proof of completion. Evidence references are literal text, not validated links or automatically retrieved sources. A new session starts fresh analysis using the remembered task; recipe checkpoint tokens and verified human decisions remain bound to their owning session. The coordinator checks live files and results before relying on remembered reports.

## Storage and limits

The default directory is `$DSH_HOME/auto-task-memory` when Harness home is explicitly configured, otherwise `~/.dsh/auto-task-memory`. Canonical repository paths select separate hashed namespaces. Both the task-memory and recipes plugins accept `memoryDir`; configure the same absolute private directory in both preset rows when overriding it. An explicit directory may be inside a repository, as in isolated previews.

Records use versioned JSON, exclusive writer locks, revision checks and atomic replacement. POSIX directories and files require private permissions; this is local access control, not encryption or protection from another process with the same user identity. Windows permissions and power-loss behavior are not equivalent to POSIX. Writers in the same process wait on the exact repository/task lock, then recheck the saved revision; a stale append still fails with a revision conflict. A foreign or unreconciled writer lock fails explicitly and requires inspection rather than automatic reclamation.

Each task retains at most 256 entries and 64 originating sessions. Entry text is limited to 4000 characters, with at most 16 literal references of 512 characters each. Reads return at most 20 entries per page; repository discovery has a bounded scan. Invalid data and exhausted capacity fail explicitly rather than silently discarding facts. This implementation does not archive or compact full tasks automatically.

## Selected methods

The host selects up to two short methods per authenticated recipe stage: behavior-evidence, independent-review and design-dependencies. Together they guide falsifiable hypotheses, appropriate evidence, independent review, retained invariants and dependencies between readers and writers. These are method instructions; platform-specific skills remain conditional on the actual task.

Methods load only from hash-checked files shipped inside this package. Workspace skills with the same names cannot replace them. Their names, versions, digests and contents appear in the child's logged prompt and remain present on replacement attempts. Required missing or changed files fail the stage. The recipes plugin accepts `stageSkillsEnabled: false` for an explicit deployment override; its default is true.

No additional recipe stages or agents are needed. Source-only preparation retains its existing read-only tools; method instructions do not add the `skill` tool or any execution capability. Native keyless Session recordings verify visible prompts and cross-session tool behavior. They do not establish external-model quality, latency or token savings; those require paired provider-backed evaluations.
