---
name: pr-shepherd
description: Shepherd one GitHub pull request to a clean, mergeable state. Monitors CI, incoming reviews, and merge conflicts on that PR, fixes what is clear-cut (lint and format failures, mechanical test and build failures, settled review comments, trivial conflicts), and escalates anything ambiguous or risky. Use when the user wants a single PR babysat, watched, or driven to green, with phrases like "shepherd this PR", "watch PR 123 to green", "keep my PR healthy", or "drive the PR to merge-ready". It does not start on its own when a PR opens. For the whole queue at once use orbit-starter:monitor-prs.
user-invocable: true
---

Shepherd one PR from "just opened" to "clean and merge-ready". This is a long-running loop over three signals, CI,
reviews, and merge conflicts, that reacts to each as it changes. The point is to take the babysitting off the author:
keep CI green, keep reviewer feedback handled, keep the branch mergeable, and step in only for the calls a person
has to make.

It runs only when asked, by the user or by whoever dispatched it. Nothing launches it when a PR opens.

It orchestrates two sibling skills rather than reinventing them:

- `orbit-starter:ci-watch` classifies and fixes CI failures.
- `orbit-starter:address-pr-comments` responds to reviewer feedback.

You extend both for autonomous operation. The escalation rules below win where they conflict, notably
address-pr-comments' approval gate before posting.

For the whole queue of open PRs use `orbit-starter:monitor-prs`, which dispatches `orbit-starter:pr-fixer` one-shots.
This skill is the single-PR version.

## Read the repo first

- The repo profile (`.claude/orbit/repo.json`). `gates` replaces every test, lint, and format command in this skill.
  `merge` and `resolveThreads` (each `ask`, `auto`, or `never`, default `ask`) decide what you may do at the end.
  A missing key means "skip that step".
- The runbook, when the profile names one under `runbook`. It lists the required checks, the known flakes, and the
  reviewer team. A PR is merge-ready on its required checks, not on every check. A failure that matches a listed
  flake gets the flake treatment in `references/ci-failures.md`.
- The GitHub lessons in `orbit-starter:monitor-prs` (its github reference) apply here too: read the latest review per
  author rather than any approval, and know that a push can dismiss an approval.

## Autonomy posture: escalate on judgment

The whole point is unattended operation, but not reckless operation.

**Handle autonomously (fix, push, post, with no asking):**

- Lint and formatting failures.
- Test and build failures with a mechanical, unambiguous fix (outdated snapshot, renamed import, changed selector,
  stale mock) where the fix restores prior intent instead of changing behavior.
- Replying to and fixing **settled** review comments: a clear bug the reviewer is right about, a low-risk readability
  or naming nit in code this PR touched, a question you can answer factually from the code.
- **Trivial** merge conflicts: lockfiles, both-added imports, changelog or import-ordering collisions, generated files.

**Escalate (pause the loop, report, wait for the user):**

- Any CI fix that means changing real business logic, or where the root cause is unclear after one honest diagnosis.
- Ambiguous review comments: reasonable both ways, or hinging on product intent, team convention, or context you
  don't have.
- **Semantic** merge conflicts: the same logical lines changed on both sides, anything in core business logic, or a
  conflict whose correct resolution depends on both authors' intent.
- Anything that has used up its retry budget (see `references/ci-failures.md`).

You never silently stop. An escalation carries a clear report (see Escalation report) so the user knows what is
blocking and what you would do next. Escalation is a pause, not an abandonment: once the user answers, resume.

### How to escalate

- **Inside Orbit** (the `mcp__orbit__needs_you` tool is available): raise it with the blocking question and up to six
  options, each a button that sends its own text. Put the specific change you would make as the first option so a
  single tap proceeds. Raise one needs_you per PR at a time, and withdraw it with `mcp__orbit__withdraw_needs_you`
  if the situation resolves on its own.
- **Interactive, outside Orbit:** ask the user inline.
- **`--unattended`**, with no way to ask: stop the loop and return the Escalation report as your final message. Never
  block waiting on input you can't receive.

## Phase 0: Resolve the PR and confirm it's worth shepherding

**Input**: `$ARGUMENTS`, a PR number or URL, optionally `--unattended`, `--max-loops <n>`, `--poll <seconds>`.

```bash
gh auth status
gh pr view <number> --json number,title,headRefName,baseRefName,author,url,isDraft,state,mergeable,mergeStateStatus,statusCheckRollup,reviews,commits
```

- A PR number or URL in `$ARGUMENTS` wins. With none and an interactive session, use the PR for the current branch
  (`gh pr view --json ...`). With none and `--unattended`, report there is no PR to shepherd and stop.
- If `state` is not `OPEN` (merged or closed): report and stop.
- If `isDraft` is `true`: a draft isn't ready for the full treatment. Interactive, ask whether to proceed anyway.
  `--unattended`, stop and don't burn cycles on it.

Print a header so the user can see what is being shepherded:

```
Shepherding PR #<number>: <title>
   <head> -> <base>   |   author: <author>
   CI: <rollup state>   Reviews: <approving / blocking authors>   Mergeable: <mergeable>/<mergeStateStatus>
   Mode: <unattended | interactive>
```

## Phase 1: The monitor loop

Each iteration (a tick) reads the PR's current state once, then dispatches to whichever signal needs attention.
Re-fetch fresh state at the top of every tick.

```bash
gh pr view <number> --json state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,reviews,commits,comments
```

### Tick decision order

Act on the **first** condition that matches, then loop back after a short pause. Order matters: a conflicted branch
can't get clean CI, so fix mergeability before chasing checks.

1. **PR closed or merged**: go to Phase 5. Merged is success. Closed unmerged: report and stop.
2. **Branch conflicts** (`mergeable == "CONFLICTING"` or `mergeStateStatus == "DIRTY"`): Phase 2. Resolve trivial
   ones, escalate semantic ones. `mergeable` can lag reality, so if it reads `UNKNOWN`, wait a tick before acting.
3. **CI failing** (`statusCheckRollup` has any `FAILURE`, `TIMED_OUT`, `ACTION_REQUIRED`, or `CANCELLED` that isn't a
   known flake awaiting its one rerun): Phase 3. A failing check that is not required and is named as noise in the
   runbook gets a note in the summary and no fix.
4. **CI still running** (`PENDING`, `IN_PROGRESS`, `QUEUED`): a wait tick. Pause and loop.
5. **New unresolved review feedback** (a review or unresolved thread newer than the last one you handled; keep that
   high-water mark across ticks): Phase 4.
6. **All green**: required checks passing, no unresolved threads, `mergeable == "MERGEABLE"`, and a real approval
   (below). The PR is merge-ready. Go to Phase 5 with a ready outcome.
7. **Quiescent but not done**: green CI, mergeable, no real approval. Nothing is actionable. Keep monitoring. This is
   the normal waiting-for-review state, and the runbook's reviewer team says who is being waited on.

**What counts as approved.** Not `reviewDecision`: under rulesets it reads null on every PR, so null means "unknown",
never "no review required" and never "approved". Read `reviews` the way
`../monitor-prs/references/github.md` does: take each author's latest `APPROVED`, `CHANGES_REQUESTED`, or `DISMISSED`
review. The PR is approved when at least one author's latest review is `APPROVED`, no author's latest is
`CHANGES_REQUESTED`, and the approval is newer than the head commit. An older approval, or a dismissed one, sends the
PR to step 7. Only treat a PR as needing no review when the runbook or the ruleset says so explicitly.

### Pacing and budgets

- **Poll interval**: default 60 seconds between ticks while waiting. `--poll` overrides it. After you push a fix,
  wait about 15 seconds so GitHub registers the new run.
- **`--max-loops`**: default 120 ticks. It is a safety backstop, not a deadline. At the cap, write a status report
  and stop.
- Print a one-line heartbeat every few minutes of waiting: `tick <n>: CI running (<elapsed>), nothing else pending.`

## Phase 2: Conflicts

A conflicted branch blocks everything else, so handle it first. Read `references/conflicts.md` for the decision
tree. The short version:

1. Sync the base branch and attempt an integration:
   ```bash
   git fetch origin <base>
   git merge origin/<base>      # or rebase: match the repo's norm
   ```
   Match how the base branch's history looks. A history full of merge commits means merge. Default to merge.
2. Inspect every conflicted file before touching it (`git diff --name-only --diff-filter=U`, then read each) and
   classify:
   - **Trivial** (lockfiles, both-added imports, import ordering, generated files, changelog stacking): resolve
     mechanically, following the reference.
   - **Semantic** (same logical lines changed on both sides, business logic, anything where you would be guessing at
     intent): escalate. Run `git merge --abort` to leave the branch clean, and report exactly which files and hunks
     need a person.
3. After resolving trivial conflicts, run the profile's `gates.lint` and `gates.test` locally before pushing. A clean
   merge can still break the build. Then commit the merge and push.
4. Loop back. The push re-triggers CI, which the loop then watches.

Never force-push to resolve a conflict, and never blow away the other side's changes to make a merge go away. If you
can't resolve it honestly, escalate.

## Phase 3: CI failures

Reuse `orbit-starter:ci-watch`'s classification. It identifies the failing job and step and sorts the failure into a
category. Then apply this skill's autonomy posture, which goes further than ci-watch does alone:

| Failure      | ci-watch alone   | pr-shepherd                                                                                                 |
| ------------ | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Format       | auto-fix + push  | same, auto-fix + push                                                                                       |
| Lint         | auto-fix + push  | same, auto-fix + push                                                                                       |
| Unit test    | report + suggest | dispatch `orbit-starter:test-healer` with the failing test and its CI log; escalate if it is a real failure |
| E2E test     | report + suggest | dispatch `orbit-starter:test-healer` the same way; escalate if it is a real regression                      |
| Build / type | report + suggest | fix clear type and import errors; escalate if it implies a design change                                    |
| Dependency   | report only      | escalate (rarely safely auto-fixable)                                                                       |
| Unknown      | report raw log   | escalate with the log excerpt                                                                               |

`references/ci-failures.md` covers how to drive test-healer and what counts as mechanical. Verify a fix locally by
running the affected gate before you push. Don't push a guess and let CI tell you. After pushing, loop back; the new
run is watched on the next tick.

**Flaky tests:** a failure that matches a known flake in the runbook, or that looks like infrastructure noise, gets
one rerun of the failed jobs (`gh run rerun <id> --failed`) before it counts as real. Green on rerun: note it and
move on. The same failure twice: treat it as real.

## Phase 4: Reviews

New reviewer feedback goes through `orbit-starter:address-pr-comments`, which is built around a person approving
every reply before it posts. Unattended there is nobody to approve, so apply this override:

- Follow address-pr-comments' gather, decide, and fix phases as written (all open comments, fix vs justify, one
  commit for the fixes).
- Replace the human-approval gate with the autonomy posture. For **settled** comments (clear fix, low-risk nit,
  factual question) draft the reply and post it directly. For **ambiguous** comments, don't guess: collect them and
  escalate.
- Keep address-pr-comments' tone rules intact. Thread resolving follows the profile's `resolveThreads`, handled the
  way that skill describes: `never` leaves every thread to the reviewer, `ask` offers it once as part of the batch,
  `auto` resolves a thread after its reply is posted and its fix has pushed.

Clear-cut feedback gets handled end to end, fix committed and reply posted, without bugging the user. Judgment-call
feedback waits. After posting fixes, the push re-triggers CI and the loop watches it.

Interactive, you may instead run the full address-pr-comments skill and let the user approve, depending on how much
sits in the ambiguous bucket.

## Phase 5: Exit and report

The loop ends in one of four outcomes. Always print a final summary.

**Merge-ready.** CI green, no open threads, mergeable, approved or no review required:

```
PR #<number> is merge-ready
   CI: all checks passing   Reviews: <approved by whom>   Mergeable: clean
   Handled this run: <N CI fixes, M comments, K conflicts resolved>
```

What happens next follows the profile's `merge`:

- `never`: stop with the ready summary. The user merges.
- `ask`: raise one needs_you offering "Merge" and "Not yet". Merge only on the first. Outside Orbit, ask inline.
  Unattended with no way to ask, return the ready summary as your final message. If the user's request already said
  to merge, that counts as the answer, but re-check the approval and the checks right before you merge.
- `auto`: merge it with the repo's usual method once required checks pass and the PR is approved, then confirm.

**Merged.** Someone merged it while you were shepherding: confirm and stop.

**Escalated.** See the Escalation report.

**Backstop hit.** You reached `--max-loops`: report the current state and what is still pending so it is easy to
relaunch.

### Escalation report

When you escalate, the user needs to act fast and correctly. Be specific:

```
PR #<number> needs your call

What's blocking:
  <e.g. "Unit test cart-data-access is failing. The assertion change isn't mechanical, the response shape
   actually changed and I don't know which side is right.">

What I tried:
  <one or two lines: diagnosis done, fix considered, why I stopped>

What I'd do with a green light:
  <the specific change you would make, so a "yes" is enough to proceed>

Everything else is handled: <CI state, other comments addressed, branch mergeable>.
Reply and I'll pick the loop back up.
```

Under `--unattended`, this report is your final message. Don't keep polling after escalating; the user resumes you.

## Guardrails

- Never `git push --force`, `git reset --hard`, or a merge that clobbers the other side.
- Never merge outside what the profile's `merge` allows.
- Never post a reply claiming a fix works without having verified it locally first.
- Stay scoped to this PR's branch. Don't refactor unrelated code or touch other branches.
- One commit per fix batch (CI fixes, review fixes), matching address-pr-comments. Keep the commit trailer your
  setup uses.
- If the same failure recurs after a fix push, don't retry the same fix. That is the signal to escalate (see the
  retry budgets in `references/ci-failures.md`).
