# Finding schema

Every specialist agent returns a JSON array of findings. Nothing else — no prose
before or after the array. An empty result is `[]`.

The orchestrator assigns `id` after collection; agents omit it.

## Finding object

| Field        | Type                                            | Required | Notes                                                                                     |
| ------------ | ----------------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `agent`      | string                                          | yes      | The agent name, e.g. `orbit-starter:review-contract`                                      |
| `file`       | string                                          | yes      | Repo-relative, forward slashes                                                            |
| `line`       | number                                          | yes      | 1-based, must be a line present in the PR diff for inline posting                         |
| `endLine`    | number                                          | no       | For multi-line findings                                                                   |
| `severity`   | `important` \| `nit` \| `pre-existing`          | yes      | See below                                                                                 |
| `confidence` | number 0–100                                    | yes      | Below 60 will be dropped by the verifier                                                  |
| `title`      | string, ≤ 80 chars                              | yes      | Imperative or declarative, no severity prefix                                             |
| `claim`      | string                                          | yes      | What is wrong and what it causes. Mechanism, not vibes.                                   |
| `evidence`   | string[]                                        | yes      | Each entry is a file path, a line number, then what it shows. At least one must be a source line, not a doc ref. |
| `fix`        | string                                          | yes      | Concrete and actionable. Not "consider refactoring".                                      |

## Severity

| Value          | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `important`    | A bug that should be fixed before merging                               |
| `nit`          | Minor; worth fixing but not blocking                                    |
| `pre-existing` | A real bug in the codebase that this PR did not introduce               |

`important` is reserved for findings that would **break behavior, corrupt or leak
data, or block a rollback**. In practice that means: incorrect mapping of
upstream data, unscoped or client-asserted authorization, silent failures on
external calls, contract breaks with real consumers, and leaked subscriptions or
handles in long-lived components. Style, naming, and refactoring suggestions are
`nit` at most. A repo's runbook can add to this list for its own stack.

## Verifier output

The verifier returns one object per candidate, same order:

| Field            | Type                                        | Notes                                            |
| ---------------- | ------------------------------------------- | ------------------------------------------------ |
| `id`             | string                                      | Unchanged from the candidate                     |
| `verdict`        | `confirmed` \| `downgraded` \| `rejected`   |                                                  |
| `severity`       | severity \| null                            | Final severity; `null` when rejected             |
| `confidence`     | number 0–100                                | Re-scored independently                          |
| `reason`         | string                                      | Why, citing what was read                        |
| `correctedClaim` | string \| null                              | Set only when the bug is real but the claim wrong |

## Reporting rules

Applied by the orchestrator after verification:

- Drop everything `rejected`, and anything with `confidence < 60`.
- Deduplicate: same `file` within ±3 lines and substantially the same claim →
  keep the highest-confidence one, merge the `evidence` arrays, and note the
  other reporting agents.
- Sort `important` → `pre-existing` → `nit`; within each, by confidence descending.
- **Cap `nit` at 5.** Report the remainder as a count in the summary.
- Cap `pre-existing` at 3.
- Never report anything the repo's gates (`gates.lint`, `gates.format`, `gates.test` in the profile) already enforce.
