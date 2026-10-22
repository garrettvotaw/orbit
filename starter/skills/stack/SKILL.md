---
name: stack
description: Build a whole feature on one runnable integration branch, then derive build-verified stacked PRs from it. Runs only when the repo profile has stack.enabled true. Use for "stack start", "stack plan", "stack materialize", "stack status", "stack fix", "stack sync", "split this branch into PRs", "decompose this into reviewable PRs", "what's the status of my PR stack", "which of my PRs is blocked", or "pick up where the stack left off". Also the resume path whenever a session starts and the stack registry has active stacks.
user-invocable: true
---

# /stack: integration-branch-first PR decomposition

Build the whole feature on one branch that actually runs. Derive the PRs from it afterward.

**Never reason about a stack from memory. Read disk first, every time.**

## Is it on

Read the repo profile (`.claude/orbit/repo.json`). If it has no `stack` key, or `stack.enabled` is not true, say the
stack is off for this repo and stop. The keys this skill reads are `baseBranch`, `prefix`, `prLink`, `serve`,
`gates`, and the `stack` object (`layers`, `graph`, `spine`, `verify`, `cutRoot`, `maxPrsPerRun`). See the repo
profile doc for each.

```
~/.claude/stack-registry.json          entry point: active stacks -> worktree paths
<worktree>/.stack/manifest.json        intent: what each slice owns, and the DAG
<worktree>/.stack/state.json           runtime: PR numbers, statuses, approved SHAs
```

If those files plus this document don't tell you what to do next, that's a bug in the system, not a licence to
guess.

All commands run through one script, from the plugin's skill folder:

```bash
node <this skill's folder>/scripts/stack.js <cmd> [--feature <name>]
```

`<cmd>` is one of registry, register, unregister, plan, cut, union, hash, status, gate, body, demo. Every command
prints JSON except `body`.

---

## Non-negotiable rules

1. **A slice merges only when the gate passes.** Run `stack.js gate` and read it. Never merge from your own
   reading of a PR page. A repo whose ruleset keeps approvals after a push will report APPROVED for code no human
   ever read. The gate tracks the commit a human approved and refuses anything else.
2. **Never force-push.** Re-materializing adds a commit. That is why it is safe and why reviewer comments stay live.
3. **Never check out a branch in the integration worktree.** The dev server runs there. All cutting happens in the
   cutting worktree (`stack.cutRoot`, else a `.stack-cut` folder beside the repo).
4. **Never use the profile's `gates.format` as a slice gate.** A pinned formatter and line-ending differences can
   flag every file locally. CI is the authority on formatting. The runbook says if your repo is clean.
5. **`.stack/**` is never assigned to a slice**, and the integration branch never merges to the base branch.
6. **No PR opens until every slice in the set builds standalone.** Standalone means the slice's own worktree: its
   base plus that slice only. The default check is the profile's `gates.lint` and `gates.test`, which proves a build
   only if the test command compiles everything. A repo whose test command doesn't sets `stack.verify` to its
   build-and-test command. Tell the user so at `/stack start` when the profile has no `stack.verify`.
7. **Fix review feedback in the integration worktree**, never on a slice branch.
8. **Merging is the user's call under the profile's `merge` key.** With `ask` (the default) raise one batched
   `needs_you` for every mergeable slice, at most 6 buttons (Orbit refuses more). Slices merge bottom-up, so the
   buttons follow stack order: "Merge next" (the lowest mergeable slice), "Merge all ready" (in order), and "Not yet".
   Per-slice buttons are fine only when they fit under the cap, still lowest first. The question lists every
   mergeable slice with a few words on where it stands. Only `auto` merges without asking, and `never` leaves it to
   the user. The gate decides what is mergeable, the profile decides whether you ask.
9. **Only the top slice closes the story.** Every slice commit and PR names the story, but only the slice that
   completes it (the top of the stack, the last in `stack.js` order) carries the profile's `prLink` as written. Every
   other slice gets the link with a leading closing keyword (close, fix, resolve, any tense) stripped, so merging
   slice 1 never closes the story. `plan --write` bakes this into each slice title, and `body` does it for the PR body.

---

## `/stack start <story-id> [feature-name]`

1. Read the story with `mcp__orbit__get_story` for title and AC.
2. Create the integration worktree from the repo root, branch named from the profile's `prefix`:
   ```bash
   git worktree add ../<feature>-integration -b <prefix>/<feature>/integration <baseBranch>
   ```
   Then run the `orbit-starter:worktree-bootstrap` skill on it, so the gitignored files in `worktree.copy` and the
   links in `worktree.link` are in place. A fresh worktree lacks them.
3. Write a **rough slice sketch** to `.stack/manifest.json`: ids, titles, `needs`, empty `owns`. Intent only;
   `/stack plan` reconciles it against reality later. Base it on the story's AC and the layers you expect to touch.
4. Register it, with the slice ids from the sketch:
   ```bash
   node scripts/stack.js register --feature <feature> --story <story-id> --worktree <path> \
     --branch <prefix>/<feature>/integration --slices type,api,ui
   ```
5. Tell the user the worktree path and the profile's `serve` command to run there, if the profile has one. If the
   profile has no `stack.verify`, say the slice check will be lint and test only, and ask whether the test command
   compiles everything or `stack.verify` needs a build-and-test command.

Then build the feature there, with TDD, iterating against the running app. Stay in that worktree.

## `/stack plan`

```bash
node scripts/stack.js plan --feature <name>            # report only
node scripts/stack.js plan --feature <name> --write     # commit the manifest
```

Derives slices from the base branch diff against the integration branch, classified by `stack.layers` (and the
project graph when the profile names one), reconciles against the sketch, and checks the invariants.

**Read the report and stop on these:**

- `invariants.unassigned`: files nobody owns. **Never invent ownership.** Show them to the user and ask.
- `invariants.multiOwned`: two slices claim one file. The boundary is wrong.
- `unresolvedSpineKeys`: a spine key whose owner couldn't be guessed. Ask the user which slice adds it.
- `unmapped`: files outside every graph project (root configs, workflows). Assign explicitly or add to the spine.

**Report, don't block, on these:**

- `spineConflicts`: parallel slices both touching a spine file. Expect a trivial conflict on the second merge; the
  PR shepherd resolves it. **Do not serialize them**, that collapses the parallel fan on every feature.
- `drift`: where reality diverged from the sketch. Normal and informative.

Show the user the DAG, the bases, and `parallelRoots` before writing. `--write` refuses if invariants fail or spine
keys are unassigned.

**The derived DAG can under-constrain.** If a dependency predates the diff, the graph shows no edge and the slice
looks independent. The standalone build catches it. Trust the build over the graph. With no `stack.graph`, no edges
are derived at all, so the sketch's `needs` and the build are the only guard.

## `/stack materialize`

```bash
node scripts/stack.js cut --feature <name>              # all slices
node scripts/stack.js cut --feature <name> --slice ui    # one slice
```

Cuts or forward-updates every slice branch in the cutting worktree, in topological order, and reports a `verify`
command per slice. Slices whose `contentHash` is unchanged are skipped.

**Then, in order:**

1. **Check `union.ok`.** If false, `missing` lists files no slice carries, so the manifest is wrong. Fix it and
   re-cut. Do not proceed.
2. **Verify every slice builds standalone.** Run each `verify` command in its own throwaway worktree of the slice
   branch (its base plus that slice only, never the integration branch), dispatching one `Agent` per slice in a
   single message so they run in parallel. With no `stack.verify` the command is only lint and test, so say that
   plainly if the repo's test command doesn't compile everything:
   ```
   git worktree add --detach ../.stack-verify/<slice> <slice-branch>
   <the verify command, run inside that worktree>
   ```
   Link `node_modules` (or whatever `worktree.link` names) into each one first. A failure means the manifest is
   wrong: something the slice needs was assigned downstream. The module-resolution error usually names the missing
   piece, which tells you which slice should own it.
3. **Only when all slices are green**, push and open PRs for slices whose `needs` have all merged (`openable` in
   `stack.js status`). Others stay `verified` and unopened.
4. **Cap PRs per invocation at `stack.maxPrsPerRun`** (3 by default), so the monitor is not handed a burst. Say
   what you deferred.
5. **PR body**: `node scripts/stack.js body --feature <name> --slice <id>` prints the slice n-of-N header, the DAG,
   what the slice owns, and the demo line. Title the PR with the slice's manifest title, which already carries the
   right story link (closing on the top slice only, rule 9).
6. **Board**: if the state's `trackerStage` is not already building, call `mcp__orbit__move_story` with stage
   `building` and record it in the state. Idempotent, never double-fire, and never move a story backward.
7. **Running comment**: post the slice table with `mcp__orbit__comment_on_story` and marker `stack`. Orbit edits the
   earlier comment with that marker, so there is one comment, not one per run.

## `/stack status`

```bash
node scripts/stack.js status                  # all stacks, reconciles against GitHub
node scripts/stack.js status --offline        # disk only, no gh call
node scripts/stack.js gate --feature <name>   # why each slice is or isn't mergeable
```

One GraphQL call covers every PR in the set. Report per slice: status, PR, and for anything not mergeable the exact
`blocking` reasons.

**For each slice in `mergeableNow`:** apply rule 8. Merge on the user's yes (or straight away under `merge: auto`),
then re-run to open whatever just became `openable`.

**For anything blocked**, `stack.js gate` prints what the user must do. `stale-approved` means re-approval is
genuinely required. Say so plainly; it isn't a bug.

Refresh the slice table with `mcp__orbit__comment_on_story`, marker `stack`.

## `/stack fix [slice-id]`

The habit change: **fix in the integration worktree.**

1. Make the fix there. Confirm the app still runs.
2. Re-run `/stack materialize`. Content hashes decide what changed; untouched slices aren't re-pushed.
3. Changed slices get a **new commit**, so reviewer inline comments stay live.
4. Any slice whose head moved past its approval becomes `stale-approved`. Tell the user which PRs need re-approval.

## `/stack sync`

`stack.js status` with no merging. Reconcile and report only.

## `/stack finish`

All slices merged: move the story forward with `mcp__orbit__move_story` (the stage the PM's brief names, else leave
it), post the final slice table with marker `stack`, then clean up:

```bash
git worktree remove ../<feature>-integration
git worktree remove --force <cut folder>/<feature>
git worktree prune
node scripts/stack.js unregister --feature <name>
```

Unlink any linked `node_modules` from the worktree before removing it, so the remove cannot delete through the link.

---

## Demo capture

The highest-leverage thing here, because it attacks cost per review rather than just re-ordering the queue. A
reviewer who sees the feature work in 60 seconds reviews their slice in 15 minutes instead of deferring an hour-long
unknown.

With the profile's `serve` command running in the integration worktree, write a walkthrough with
`stack.js demo --feature <name> --steps "step one|step two"`, fill in the TODO steps with real selectors, run it with
Playwright, and capture screenshots to `.stack/demo/output/`. Attach them with `mcp__orbit__attach_to_story` (one
call per file) and link the story from every PR body. Regenerate after any `/stack fix` that changes UI. A stale
demo is worse than none.

## Waiting without burning tokens

- **Human review (hours to days):** end the turn. Nothing polls. Do not schedule a wakeup to watch for an approval.
- **CI:** the PR shepherd (`orbit-starter:pr-shepherd`) or the monitor handles it; you are re-invoked when they report.
- **Overnight:** zero processes, zero tokens. GitHub is the event log. `stack.js status` reconstructs everything in
  one call.

## Resuming cold

A session with no memory of the stack:

```bash
node scripts/stack.js registry
node scripts/stack.js status
```

That is the whole mental model. `orbit-starter:ac-verify` also reads the registry to find a stacked branch's parent.

## References

- `references/state-schema.md`: every state field, status value, and gate reason code
- `references/troubleshooting.md`: what to do when a slice won't build, union fails, or a slice goes stale-approved
