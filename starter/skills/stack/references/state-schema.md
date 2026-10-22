# State schema

Two files per stack, both under `<integration-worktree>/.stack/`. Plus one registry at
`~/.claude/stack-registry.json` (set `STACK_REGISTRY_DIR` to move it).

`.stack/**` is never assigned to a slice and the integration branch never merges to the base branch, so none of
this reaches production.

## `~/.claude/stack-registry.json`

The stable entry point. Everything else is discovered from here.

```json
{
  "stacks": [
    {
      "feature": "cart-promos",
      "story": "42",
      "worktree": "/work/cart-promos-integration",
      "integrationBranch": "feat/cart-promos/integration",
      "repoRoot": "/work/storefront",
      "createdAt": "2026-08-04T16:30:00.000Z"
    }
  ]
}
```

`register` is keyed on `feature` and replaces in place, so it is safe to call repeatedly. Optional `owner` and
`repo` fields name the GitHub repo; without them the script asks `gh` from the repo root.

## `.stack/manifest.json`

Intent. Human-authored as a sketch, then reconciled by `/stack plan`.

```json
{
  "feature": "cart-promos",
  "story": "42",
  "integration": "feat/cart-promos/integration",
  "slices": [
    { "id": "type", "title": "cart-promos shared types", "needs": [], "owns": ["libs/cart/shared/**"] },
    { "id": "data-access", "title": "cart-promos client data", "needs": ["type"], "owns": ["libs/cart/client/data/**"] }
  ],
  "spine": {
    "tsconfig.base.json": {
      "compilerOptions.paths.@cart/shared": "type",
      "compilerOptions.paths.@cart/data": "data-access"
    }
  }
}
```

**`owns`**: glob patterns. `dir/**` matches everything under a directory, `*` stays inside one path segment, a
leading `*.ext` matches by suffix, and an exact path matches one file. Every changed file must match exactly one
slice's patterns (or be a spine file).

**`spine`**: the small allowlist of files every slice touches, assigned key by key rather than whole-file. JSON
files use dotted paths; barrel files use whole export lines. A `null` value means the owner is unassigned and
`/stack plan --write` will refuse.

## The graph shape

`stack.graph` is `"nx"` or a command that prints this JSON:

```json
{
  "nodes": { "cart-types": { "root": "libs/cart/shared/type-cart" } },
  "dependencies": { "cart-data": ["cart-types"] }
}
```

## `.stack/state.json`

Runtime truth. This is the mental model that survives a closed laptop.

```json
{
  "feature": "cart-promos",
  "story": "42",
  "integrationBranch": "feat/cart-promos/integration",
  "worktree": "/work/cart-promos-integration",
  "repoRoot": "/work/storefront",
  "baseBranch": "main",
  "trackerStage": "building",
  "lastReconciledAt": "2026-08-04T16:45:00.000Z",
  "slices": { "type": { "...": "see below" } }
}
```

`trackerStage` is the last board stage **we** set, which is what makes board moves idempotent across sessions. The
running slice-table comment needs no id: `comment_on_story` with marker `stack` edits it in place.

### Slice fields

| Field               | Meaning                                                                           |
| ------------------- | --------------------------------------------------------------------------------- |
| `id`                | Slice id, matches the manifest                                                    |
| `status`            | See status values below                                                           |
| `prNumber`          | GitHub PR number, `null` until opened                                             |
| `branch`            | `<prefix>/<feature>/<n>-<id>`                                                     |
| `base`              | Branch this slice stacks on (the base branch or a parent's branch)                |
| `state`             | GitHub PR state: `OPEN` / `MERGED` / `CLOSED`                                     |
| `headSha`           | Current head commit of the slice branch                                           |
| `approvedSha`       | **The commit a human actually approved.** The load-bearing field.                 |
| `approvedBy`        | Login of that human                                                               |
| `reviewDecision`    | GitHub's `APPROVED` / `CHANGES_REQUESTED` / `null`                                |
| `unresolvedThreads` | Open, non-outdated review threads                                                 |
| `checksStatus`      | `SUCCESS` / `FAILURE` / `PENDING` / `ERROR`                                       |
| `mergeable`         | `MERGEABLE` / `CONFLICTING` / `UNKNOWN`                                           |
| `contentHash`       | sha256 of owned content at last cut, which decides whether a re-cut changes anything |
| `verifiedAt`        | When this slice last built standalone                                             |
| `blockedReason`     | Comma-joined gate reason codes                                                    |

### Status values

| Status     | Meaning                                                                              |
| ---------- | ------------------------------------------------------------------------------------ |
| `pending`  | No branch cut yet                                                                    |
| `verified` | Branch cut and builds standalone; PR not opened (usually waiting on a parent to merge) |
| `open`     | PR open, waiting on a human or on CI. Normal.                                        |
| `approved` | Gate passes, safe to merge right now                                                 |
| `merged`   | Merged to the base branch                                                            |
| `blocked`  | Needs a human. See `blockedReason`.                                                  |

`open` vs `blocked`: waiting on approval, pending checks, or uncomputed mergeability is normal open-PR life.
Anything else is `blocked`.

## Gate reason codes

| Code                   | What it means                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `not-open`             | PR merged or closed; nothing to do                                                                                  |
| `awaiting-approval`    | No human approval yet. **This is the gate, so wait.**                                                               |
| `changes-requested`    | Reviewer wants changes. Fix in the integration worktree, then `/stack fix`.                                         |
| `stale-approved`       | The approved commit isn't the head commit; someone approved older code. Re-approval required. **By design.**        |
| `unresolved-threads`   | Open review threads                                                                                                 |
| `checks-failing`       | Required checks red. The PR shepherd handles mechanical failures.                                                   |
| `checks-pending`       | Still running                                                                                                       |
| `conflicting`          | Conflicts with base. Usually a spine file.                                                                          |
| `mergeability-unknown` | GitHub hasn't computed it yet. Re-run status shortly.                                                               |

## Why `approvedSha` exists

If the base branch's ruleset has `dismiss_stale_reviews_on_push: false`, an approval survives a push. Without
tracking which commit was approved, a re-materialized slice reports APPROVED for code no human read, and GitHub
will let it merge. Check yours with `gh api repos/<owner>/<repo>/rulesets`. The gate enforces freshness either way,
so it is safe on any repo.

A bot's automatic review is a comment, never the human gate. Neither is a self-approval. The script filters both.
