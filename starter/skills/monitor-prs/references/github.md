# GitHub lessons for the PR monitor

How GitHub behaves, in every repo. Several of these contradict what the API appears to tell you. Each was measured,
not inferred. The repo's own facts (its check names, its flakes, its reviewer team, how its workflows check out code)
live in the repo's runbook; the plugin's `docs/runbook-template.md` shows what goes there.

`gh api` fills `{owner}` and `{repo}` in a path from the repo of the current folder, so the commands below run as
written.

## Rulesets, and what "approved" means

A base branch can be governed by a **ruleset** rather than classic branch protection. Read its rules with:

```bash
gh api repos/{owner}/{repo}/rules/branches/<base>
```

**`reviewDecision` is unreliable under rulesets.** It reads `null` even on an approved PR, because rulesets don't
populate it the way classic protection does. Never read `null` as "not approved". Check the real gates instead.

**And don't compute approval as `select(.state=="APPROVED")`.** That ignores a later `CHANGES_REQUESTED` from the
same reviewer and reports a blocked PR as approved. A reviewer can approve and then request changes two minutes
later; the naive filter reads that as mergeable. **Take the latest review per author:**

```bash
( [ .reviews.nodes[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED" or .state=="DISMISSED") ]
  | group_by(.author.login) | map( sort_by(.submittedAt) | last ) ) as $latest
# approving: $latest[] | select(.state=="APPROVED")
# blocking:  $latest[] | select(.state=="CHANGES_REQUESTED")
```

sum.js does exactly this. A PR with **any** blocking reviewer is not mergeable no matter how green it is, and its
threads must NOT be resolved: the resolve authority requires a live approval.

The gates a ruleset commonly carries (the runbook says which ones the repo has):

- a number of approving reviews, counted the latest-per-author way above;
- `required_review_thread_resolution`: zero unresolved review threads;
- `require_last_push_approval`: the approval must be newer than the last push;
- required status checks, all SUCCESS;
- a code-scanning gate (errors, or high-or-higher);
- `strict_required_status_checks_policy`. When it's **false**, the branch does not have to be up to date with the
  base. That's the trap behind most of [Staleness](#staleness).

`mergeStateStatus: BLOCKED` is the steady state for nearly every PR under rulesets, so by itself it's no reason to
skip a merge. Find out _which_ gate is unmet.

**The code-scanning results check can sit QUEUED long after every analysis job passed.** All required checks green,
`gh pr merge` refuses with _"the base branch policy prohibits the merge"_, and the code-scanning check stays `queued`
for most of an hour. The analysis job's log shows the upload succeeded, then _"Analysis upload status is pending …
Timed out waiting for analysis to finish processing."_ That's a processing backlog on GitHub's side. Don't rerun
anything; retry the merge when the check completes. A `NEUTRAL` result ("configuration not found") satisfies the
gate. Even then the first merge attempt can be refused once more: when REST `mergeable_state` reads `clean`, a retry
about 20 seconds later goes through. `gh pr merge --auto` only helps where the repo has auto-merge turned on; the
runbook says.

## A push and the approval

**A push can leave the approval in place and still invalidate it.** With `require_last_push_approval`, an approval
older than the last push does not satisfy the gate, so the PR _looks_ approved and is not mergeable. Always compare
the approval's `submittedAt` to the head commit's time; sum.js prints both and marks an `OLDER-THAN-HEAD` approval.
The head time is when the commit was made, not pushed: a commit made before an approval and pushed after it still
reads as covered, so a push you know came later wins.

**Whether a push dismisses the approval is unpredictable.** A ruleset that reads `dismiss_stale_reviews_on_push:
false` has still flipped an `APPROVED` to `DISMISSED` after a merge-commit push, while a plain sync push on the same
ruleset left another approval `APPROVED` but stale. A merge commit versus a plain push is the leading suspect, not a
proven one. In an older measurement, with dismissal on, a PR based on the default branch lost its approval on push
while one based on a user branch kept it. So don't count on the approval merely going stale: treat it as gone after
every push.

**Nobody gets re-requested.** When nothing is dismissed GitHub doesn't re-request the reviewer, and even after a
dismissal `reviewRequests` can come back empty. Re-request by hand after every push:

```bash
gh api -X POST repos/{owner}/{repo}/pulls/<n>/requested_reviewers -f 'reviewers[]=<login>'
```

**A PR with nobody requested** is a real and easy-to-miss gap. Request the runbook's default reviewer team:

```bash
gh api -X POST repos/{owner}/{repo}/pulls/<n>/requested_reviewers -f 'team_reviewers[]=<team slug>'
```

## Checks

### A missing required check is not a failed one

Aggregator jobs (a `… Result` job that sums up a sharded suite) **only materialize after their shards finish**. On a
fresh push the rollup shows the shards `IN_PROGRESS` and the aggregator row is simply **absent**; there is no pending
placeholder. A PR can have every other required check `COMPLETED/SUCCESS` and two aggregators missing entirely while
a shard is still running.

So **never read "required check not in the rollup" as unmet or broken.** Read the shard rows. Filtering the rollup by
required-check name alone silently under-reports:

```bash
# shows shard progress too, and coerces StatusContext vs CheckRun shapes
gh pr view <n> --json statusCheckRollup \
  --jq '.statusCheckRollup[] | "\(.status // .state)\t\(.conclusion // "-")\t\(.name // .context)"' | sort -u
```

`.name` is `null` on a `StatusContext`, so a `.name`-only filter drops those rows outright. Always fall back to
`.context`. sum.js does, and lists a required check it can't find as ABSENT, apart from RED.

### Flake or real

**Flake** is a single shard or a single attempt. **Real** is deterministic across a **fresh rerun**: a uniform
duration (a timeout), siblings in the same file passing.

"Failed all its retries" alone does not prove real. Test-runner retries (Playwright's, for one) run in the **same
container**, so a mock that fails to start fails all three identically. `gh run rerun <id> --failed`, once, is the
decisive and cheap test: a spec that fails all its retries and the fresh rerun too is real.

A spec can also flake on a different test each run and survive every retry, poisoning state for the rest of its
worker. "Survived retries" doesn't prove determinism there. Rerun it, don't dismiss it, and before blaming a PR, check
whether a sibling PR passed the same suite that day. If one did, it's the flake, not the branch.

A burst of failures across unrelated branches, all inside the same few minutes, is environmental (shared test data, a
live service, a test account someone changed). Rerun once the run finishes.

**Why a rerun gets refused, and why it is not a wedged run.** Both `gh run rerun <id> --failed` and the single-job
`POST actions/jobs/<id>/rerun` return _"This workflow is already running"_ (HTTP 403) while **any** job in the run is
outstanding. That includes jobs that drain long after every shard finished, like a report-publishing chain serialized
by a concurrency group. Confirm by listing the run's jobs:

```bash
gh api repos/{owner}/{repo}/actions/runs/<id>/jobs --jq '.jobs[] | "\(.status)\t\(.conclusion)\t\(.name)"'
```

Zero `completed/failure` shards plus previously failed shards back `in_progress` means a rerun already took. Only
publishing jobs outstanding means wait and retry next tick.

### Every suite red at once is a credential, not the code

When a secret the suites boot with goes bad, every PR in the repo goes red on the same checks at once and zero tests
execute; the log says the server failed to start on an authentication error. Grep any failing job log for that
error before believing a code-related story. Suites that wait on a server timeout look like a _different_ failure,
because they burn the whole timeout first. The runbook names the secret and the checks it takes down. One red
required check alone is not this.

**Not dispatchable and not fixable in code.** Someone with repo admin rotates the secret. Meanwhile, checks that ran
_before_ the break stay green and the ruleset honours them, so **don't push, sync, or rerun** an otherwise-green PR:
you'd trade a real green for a failure no commit can clear. Merge on the existing green if an approval lands.

**Detecting the rotation costs nothing if a job is still queued.** GitHub injects secrets at _job_ start, not run
start, so a job that queued during the outage and started after the fix reads the new value. If its run already
failed on the credential, that's a same-suite before and after for free. So before burning a rerun to test the
secret, check the run's jobs for anything `in_progress` that started after your last confirmed rejection. Then rerun
the _required_ runs on the affected head, with no push, so a reviewed commit stays reviewed.

### Shard indices

`✓ 31` / `✘ 32` in a sharded test log are **shard-wide test indices**, not per-file counts. Don't quote them as test
totals.

## Which commit CI tests

**On a `pull_request` event, `github.sha` is the `refs/pull/<n>/merge` commit, not the PR head.** A workflow whose
checkout uses it (directly, or through a variable like `CHECKOUT_REF: ${{ github.sha }}`) tests **head merged into the
base**, even though the check-run reports the head SHA. The runbook says which of the repo's workflows do this.

The consequences are large:

- **A green local run on the branch alone proves nothing.** A fixer can honestly report every suite passing and CI
  can still fail one test, with no flake and no dishonesty. A branch far behind its base is the usual shape.
- This is also why a non-strict required-checks policy is less dangerous than [Staleness](#staleness) implies for
  those checks: CI already folds the base in. What it doesn't protect is a merge GitHub can auto-resolve but that is
  semantically wrong.
- To reproduce a CI-only failure, merge the base in **without committing** and rerun:

  ```bash
  git merge origin/<base> --no-commit --no-ff   # then run the suite
  git merge --abort                              # discard when done
  ```

- Reproducing needs the **whole** suite, not the failing test by name. A test that is order- or state-dependent
  passes alone and fails in a full run.

**A workflow that checks out the PR head doesn't get the base's fixes.** A spec fix merged to the base doesn't reach a
stale PR. The tell: red only on spec files the PR never touched, in a suite the branch passed before the fix landed,
while every branch that passed that day carries the fix. **A rerun cannot fix this.** Check before burning one:

```bash
git merge-base --is-ancestor <fix-sha> origin/<branch> && echo has-it || echo missing
```

Missing means sync the base and push.

## `mergeable` lags reality

GitHub can report `CONFLICTING`/`DIRTY` for over an hour after the conflicts are genuinely resolved, with its own
`base_sha` and `head_sha` matching local and the base an ancestor of the head. Confirm with:

```bash
git merge-tree --write-tree --name-only origin/<head> origin/<base>
```

A bare tree hash with no `CONFLICT` lines means clean. A REST poke does not clear the stale flag; closing and
reopening the PR would, but that's outward-facing.

## Stacks

**Mid-stack PRs get no CI at all** when the workflows filter `pull_request` on `branches:` (the base branch and
release branches, say). That filter is on the PR's **base**, so a PR based on another PR's branch gets zero check runs,
and pushing to its head will not help. What _does_ fire the suite on a child is the **base branch moving**.

**A stack does not unwind by itself.** When a base PR merges, the child does not retarget, not automatically and not
by hand: `gh pr edit --base <base>` refuses with _"part of a stack"_ even when the child has no children of its own.
The child is then unmergeable: its base is already in the target, so merging there does nothing.

**What happens to the child depends on how the base was merged:**

- **A normal merge** (`gh pr merge`, `PUT …/merge`) **orphans** the child. The only fix is a replacement PR: sync the
  base in, `gh pr create --base <base> --head <same branch>`, and close the old one with a link to the new one.
  Approvals and threads do **not** carry over.
- **The stacked-merge path** (`merge-async`, below) **cascades the retarget properly**: the child retargets to the
  base, keeps its review state, and its full suite fires at once.

**The cascade can rebase the child and dismiss its approval.** GitHub can rewrite the child's commits onto the merge
commit (a new head SHA, committed seconds after the merge), flip its approval to `DISMISSED`, and re-request nobody.
After any cascade, re-read the child's head and reviews, and re-request the reviewer by hand.

**`merge-async` does not always cascade either.** A base can read `merged` within seconds while its child still points
at the merged base minutes later, head untouched. So after any base merge, check the child's `baseRefName` rather
than assuming the cascade ran. `gh api -X PATCH repos/{owner}/{repo}/pulls/<child> -f base=<base>` retargets it, and
dismisses its approval.

A child that is **not** a GitHub stack (a plain `gh pr merge` worked on the base) does not retarget at all.
`gh pr edit --base <base>` can hit a GraphQL error there; the `PATCH` above works, dismisses the approval, and fires no
CI until a base sync is pushed.

GitHub tells you which world you're in: if `gh pr merge` fails with _"part of a stack and must be merged using the
asynchronous merge REST API"_, it sees a stack, so use `merge-async` and the children will follow.

```
PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async
body: merge_method, and optionally sha (guards against a concurrent push)
→ {status, details:{uuid}}   then poll GET …/merge-async/{uuid}
```

**`merge-async` may trip a permission classifier as a "merge bypass"**, even though GitHub's own error message sends
you there. Get the user's explicit yes first, and verify the gates _before_ attempting, so you can show the merge was
legitimate.

**Never delete a merged base branch while a child PR points at it.** GitHub auto-closes the child.

**A PR on the base branch built on top of another open PR's head merges both.** Merging the top one marks the one
under it `MERGED` seconds later with the same merge commit, with no action on it. Only do this when the top PR's
approval covers the whole diff and the user has okayed skipping bottom-up order.

**Resolving a stack-merge conflict burst:** when the base has _rewritten_ commits the child already carries, most
conflicts are the same change arriving twice. Use `git patch-id` to separate the duplicate arrivals from genuinely new
content, then cross-check: the files that differ from the pre-merge head should be exactly the files the genuinely new
base commits touch. **Never blanket `-X ours`.** There will be a spot where the _base_ has to win, and "take ours"
silently reverts a bug fix with green tests.

## Staleness

When `strict_required_status_checks_policy` is **false**, GitHub will merge a PR on CI computed against a months-old
base. A branch can pass every test locally and go red on CI because the base removed an element one of its tests
asserted.

Before merging a stale branch, check **content overlap** rather than the behind-count (the `comm -12` recipe in the
skill's Phase 5). Zero overlap: the older CI probably still holds, don't burn a sync. Overlap: sync and re-run first.

**But zero overlap is NOT proof of safety.** A branch with zero overlapping files can sync clean and still go red on
a required check, because the base **added required steps to a flow** (a new selection and confirm step where it used
to route straight on) and the branch's spec helper still drove the old walk. The collision was in runtime behaviour,
not in source lines. So when a PR lands that adds required steps to a shared flow, sync and rerun every sibling PR
whose specs automate that flow.

Do **not** bulk-sync branches that aren't near merging. It costs runner minutes and, where a push dismisses or
outdates the approval, resets it.

## Cross-PR interference

Two PRs can both be legitimately green alone and break when combined. The mechanism to watch for: one merges a
change that **adds a required step to a shared flow** (a confirm dialog, an acknowledgement, a new mandatory
selection), and the sibling PRs' E2E helpers still automate the old, shorter flow. The originating PR can only patch
the specs that exist on its own branch.

When fixing that class: reuse the locator patterns from a spec CI already proves green, fix the **specs**, not the
app, and never skip, `fixme`, or loosen an assertion to get green.

## `gh` quirks

- `gh pr view --json X --jq` does **not** accept `--arg`. Build the filter inline.
- `gh api -F field=@file` reads the field's value from a file. Write a reply or a note with the Write tool and pass it
  that way, so apostrophes never pass through a shell.

## Commands

Reply into a review thread (the thread id is the one sum.js prints):

```bash
gh api graphql -F id=<thread id> -F body=@reply.md -f query='
  mutation($id: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { url } } }'
```

Resolve it:

```bash
gh api graphql -F id=<thread id> -f query='
  mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }'
```

A failed run's log, and a rerun of only its failed jobs:

```bash
gh run view <run> --log-failed
gh run rerun <run> --failed
```
