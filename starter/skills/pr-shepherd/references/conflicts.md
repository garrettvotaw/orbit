# Resolving merge conflicts intelligently

A conflicted branch blocks CI and merge, so the shepherd handles it before anything else. The principle: resolve only
what you can resolve honestly and mechanically, and escalate anything that requires guessing at intent. Wiping out the
other side to make a conflict disappear is never acceptable, because that silently drops someone's work.

## Step 1: Integrate the base branch

Match how the repo brings the base into feature branches. Look at the base branch's history: merge commits mean merge,
a linear history means rebase. When unsure, merge.

```bash
git fetch origin <base>
git merge origin/<base>
```

If the merge succeeds with no conflicts, the "CONFLICTING" state was stale. Push and move on. If it conflicts,
continue. Use the profile's `baseBranch` when the PR's base isn't otherwise given.

## Step 2: Enumerate and read every conflicted file

```bash
git diff --name-only --diff-filter=U
```

Read each one fully, not just the conflict markers but enough surrounding context to understand what each side was
doing. You can't classify a conflict you haven't read.

## Step 3: Classify each conflict

### Trivial: resolve mechanically

These have an obviously correct resolution that doesn't depend on business intent:

- **Lockfiles**: never hand-merge. Take the base's copy, then regenerate it with the repo's package manager against the
  merged manifest (the profile's `worktree.install` command, when set, is the repo's install step):
  ```bash
  git checkout origin/<base> -- <lockfile>
  <install command>
  git add <lockfile>
  ```
- **Both-added imports and import ordering**: both sides added different imports to the same block. Keep both, sorted
  and deduped to match the file's convention. Running the linter's fix mode or the formatter on the file usually
  settles ordering.
- **Generated files** (build output, generated types): regenerate from source rather than hand-merging, then stage the
  result.
- **Changelog or additive list stacking**: both sides appended entries to the same list. Keep both, in a sensible
  order.
- **Whitespace and formatting-only collisions**: take the functional content and let the formatter normalize.

### Semantic: escalate

The same logical code changed on both sides, or resolving correctly means knowing what each author intended:

- The same function or method body edited differently on both sides.
- Conflicts inside business logic, data transforms, contract or DTO mapping, or control flow.
- A conflict where picking a side could change runtime behavior and you can't prove which is right.
- Anything in a file you don't have enough context to reason about confidently.

For these, don't guess. Leave the branch clean for the user:

```bash
git merge --abort
```

Then report exactly which files and hunks need a decision, with a one-line description of what each side appears to
be doing. A good escalation lets the user resolve it in their editor without re-investigating. Inside Orbit, raise it
as one needs_you with the files in the question.

Before escalating, check whether it is really a conflict at all: when the base rewrote commits that this branch
carries, most conflicts are the same change landing twice. If the two sides are identical in effect, take either.

## Step 4: Validate before pushing

A clean textual merge can still break the build, because two changes that don't conflict textually can still be
logically incompatible. After resolving trivial conflicts:

```bash
git add <resolved-files>
```

Then run the profile's `gates.lint` and `gates.test`. If validation fails, you have hit a logical conflict, not a
textual one. Treat it like a semantic conflict and escalate instead of papering over it.

## Step 5: Commit and push

```bash
git commit --no-edit      # keep the merge commit message
git push
```

The push re-triggers CI; the monitor loop picks up the new run on its next tick. A push can also dismiss an existing
approval, so tell the user if the PR was approved before the merge.

## Hard rules

- Never `git push --force` or `git reset --hard` to fix a conflict.
- Never resolve by blanket-taking one side (`-X ours` or `-X theirs`) across files you haven't read. That is how real
  changes get silently dropped.
- When in doubt, abort and escalate. A paused PR is recoverable. A silently mis-merged one may not be.
