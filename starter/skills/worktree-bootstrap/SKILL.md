---
name: worktree-bootstrap
description: Make a fresh git worktree runnable. Copies the gitignored files the repo profile's worktree.copy lists (plus the env files most repos keep out of git) from the main checkout, shares the paths in worktree.link through a symlink or junction, and runs worktree.install where it can't write through a link. The orbit-starter:story-engine skill runs it right after every worktree it makes. Run by hand with a task, it makes the worktree first, bootstraps it, and does the task there.
user-invocable: true
---

# Worktree bootstrap

A fresh worktree has the tracked files and nothing else: no env files, no license files, no dependencies, no local
credentials. This skill gives it what the main checkout has, so a serve or a test run in the worktree behaves the
way it does in the main checkout.

**Input**: $ARGUMENTS

- A worktree path: bootstrap that worktree. The story engine passes the one it just made.
- A task description: make a worktree for it first, then bootstrap it and do the task there. See
  [By hand, with a task](#by-hand-with-a-task).
- Nothing: nothing to do. Say so and stop.

Use forward slashes in every path. `git` and Node accept them on every platform.

## Read the profile

`.claude/orbit/repo.json` in the main checkout:

- `worktree.copy`: gitignored files to copy. An entry is a repo-relative path or a glob. Can be empty.
- `worktree.link`: paths to share with the main checkout instead of copying. Can be empty.
- `worktree.install`: the command that installs dependencies. Optional; with none, skip [Install](#install).

With no profile, copy only the env files below, link nothing, and install nothing. Say so in your summary.

## Find the main checkout

```bash
git -C <worktree> worktree list --porcelain
```

The first `worktree` line is the main checkout. Every copy and link reads from there. If the worktree you were
given is the main checkout itself, there is nothing to do: stop.

## Copy

Copy each entry of `worktree.copy`, and always these env files too, which most repos keep out of git:

- every `.env*` file at the repo root;
- every `.env.local` file anywhere in the repo, at the same relative path.

For each one:

- **Missing in the main checkout:** skip it quietly. Not every repo has every file.
- **Already in the worktree:** leave it. Never overwrite; the worktree's copy may have been edited on purpose.
- Create the parent folders the destination needs.
- A glob, and the `.env.local` search, walk the whole main checkout but never descend into `node_modules` or
  `.git`. Each match lands at the same relative path in the worktree.

## Link

For each entry of `worktree.link`:

- **Missing in the main checkout:** skip it and note it.
- **Already in the worktree:** leave it.
- Otherwise make a link at the worktree's path that points at the main checkout's: a symlink, or a junction on
  Windows, which needs no admin rights. Node makes the right one on every platform:

  ```bash
  node -e "require('fs').symlinkSync(process.argv[1], process.argv[2], 'junction')" <main>/<path> <worktree>/<path>
  ```

  A junction only works for a folder. To share a single file, put it in `worktree.copy` instead.

A linked path is shared, never reinstalled or copied. A link is not a copy: anything that deletes through it
deletes the main checkout's files.

## Install

Run `worktree.install` from the worktree, unless it would write into a linked path. An install inside a linked
folder writes through the link into the main checkout, and some installers (`npm ci`) delete the folder first. So:

- `link` holds the folder the install fills (`node_modules` for npm): skip the install. The link already carries
  the dependencies.
- `link` is empty, holds only other paths, or that link was skipped: run the install.

## When something fails

A file that won't copy or a path that won't link doesn't stop the bootstrap. Skip it, note it in one line, and
carry on. The first command that needs it will fail, and your note says why.

## Summary

One line: what you copied, what you linked, and whether the install ran (and why not, when it didn't). Name every
path you skipped other than a quietly missing env file.

## By hand, with a task

1. **Name it.** Derive a short kebab-case name from the task ("add unit tests for the price service" →
   `price-service-tests`). The worktree goes at `../<repo-name>-<short-name>`. The branch is the profile's
   `branchTemplate` filled with its `prefix`, using the short name where the template wants a slug; with no story
   id, drop the id part (`<prefix>/<short-name>`).
2. **Make it.**

   ```bash
   git worktree add ../<repo-name>-<short-name> -b <branch> <baseBranch>
   ```

3. **Bootstrap it**, as above.
4. **Do the task** in the worktree yourself, in this session. Use the worktree path as the base directory for every
   read, edit, and command. Do the actual work: write the code, write the tests, make the changes.
5. **Report back** to the user:
   - the worktree path;
   - the branch name;
   - a summary of what was done;
   - how to clean up when done: remove each link the bootstrap made first (delete the link itself, never what it
     points at), then `git worktree remove ../<repo-name>-<short-name>`.
