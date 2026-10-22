# Troubleshooting

## A slice won't build standalone

**The manifest is wrong.** Something the slice needs was assigned to a slice downstream of it.

Read the error. A module-resolution failure names the missing piece:

```
Cannot find module '@cart/shared'
```

Find which slice owns that library, and either make this slice depend on it (add to `needs`) or move the ownership.
Then re-cut. **Trust the build over the graph.** The graph is the opening guess; the build is ground truth.

## The derived DAG says two slices are independent, but one imports the other

Real limitation. The graph shows dependencies as they exist _now_. If the app already imported the library before
your change, there is no new edge in the diff, so the plan marks both as parallel roots. With no `stack.graph` in
the profile there are no derived edges at all.

The standalone build catches it. When it does, add the `needs` edge to the manifest by hand and re-cut.

## `union.ok` is false

`missing` lists files that no slice carries. The stack would drop them silently, which is exactly what the
invariant exists to prevent.

For each missing file, decide which slice should own it, add a pattern to that slice's `owns` (or a key to `spine`),
re-run `plan --write`, and re-cut.

`extra` means a slice carries a file that isn't in the integration diff, usually a stale slice branch from a
manifest that changed. Delete the branch and re-cut.

A file the feature **deleted** is a known gap: the cut checks owned paths out of the integration branch, and a
deleted path has nothing to check out. Delete it by hand on the slice branch in the cutting worktree, or add the
deletion to the first slice's commit yourself, and say so in the PR.

## `unassigned` files in `/stack plan`

Never invent ownership. Show them to the user. Common cases:

- Root-level configs and workflow files: usually belong in the first slice, or add to `stack.spine`
- A brand-new project the graph hasn't picked up: regenerate the graph (for nx, `npx nx reset`) and plan again
- Files that genuinely shouldn't ship: revert them in the integration worktree

With no `stack.graph`, each changed file lands in the first layer whose `paths` match, else in `other`. A layer
list that is too coarse or too thin shows up here first.

## `unresolvedSpineKeys`

A spine key whose owner couldn't be guessed. The guess matches the alias against the leaf folder names the slices
own, so unusual aliases miss.

Ask the user which slice introduces that alias or export, set the value in `manifest.spine`, and re-run.

## Spine conflict on merge

Expected. Two parallel slices both added a path alias, and the second one to merge conflicts.

**Do not serialize the slices to avoid this**, that collapses the parallel fan on every feature, which is the whole
point of the DAG. The PR shepherd resolves trivial both-added conflicts. If it escalates, the resolution is almost
always "keep both aliases."

## A slice is `stale-approved`

Working as designed. The head commit moved past the commit a human approved, usually because `/stack fix`
re-materialized it after review feedback.

Tell the user plainly which PR needs re-approval because the code changed after it was approved. Do **not** merge it.
The repo's own ruleset may not stop you, which is precisely why the gate checks this.

## Integration worktree is missing gitignored files

A fresh worktree lacks anything gitignored. Run the `orbit-starter:worktree-bootstrap` skill on it, which copies the
profile's `worktree.copy` files and links `worktree.link`.

## `git worktree add` fails: branch already checked out

A slice branch can only be checked out in one worktree. The cutting worktree is created `--detach` for this reason.
If it happens anyway:

```bash
git worktree list          # find who holds it
git worktree prune         # clear stale registrations
```

## `cut` throws "checkout failed"

Usually leftover uncommitted state in the cutting worktree from an interrupted run. The cut resets and cleans on
entry, but if it's wedged:

```bash
git worktree remove --force <cut folder>/<feature>
git worktree prune
```

Then re-run `cut`, which recreates the worktree. Unlink any linked `node_modules` from it first.

## The script cannot resolve a path

Pass absolute paths for `--worktree` and `--repo`, in the form your shell and Node both read. A path style Node
can't resolve shows up as a spawn error with the working directory in it.

## Reconcile fails

`status` catches `gh` errors and reports them as a delta rather than crashing. Check:

```bash
gh auth status
```

`--offline` reads state from disk with no network call, which shows the last-known picture when `gh` is broken.

## Everything looks wrong / state seems corrupt

State is just JSON. Read it:

```bash
node scripts/stack.js status --offline
```

The integration branch is the source of truth for _code_; state.json only tracks PR bookkeeping. Worst case, slice
branches can be deleted and re-cut from the integration branch. Nothing is lost, since the manifest plus the
integration branch fully determine the stack.
