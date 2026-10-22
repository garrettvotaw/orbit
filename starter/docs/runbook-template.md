# Runbook template

Copy this to `.claude/orbit/runbook.md` in your repo, point the repo profile's `runbook` at it, and replace every
example with your repo's own facts. The PR monitor and its fixers read it, and so do the debugger, the test healer,
and the PM. `examples/nx-web-api/.claude/orbit/runbook.md` is a filled-in one.

Keep it short and true. Several of these facts will contradict what the GitHub API appears to tell you, so date
what you measured ("measured 2025-03-04 on #41") and say what you saw, so the next reader can tell a measurement
from a guess and knows how old it is.

GitHub behaviour that holds in every repo (latest review per author, last-push approval, missing aggregator checks,
stacks, staleness) lives in the monitor-prs skill's `references/github.md`. This file holds only what's true of
yours. Every section is optional: leave one out and the skills that read it skip that step.

## Merge gates

Read the base branch's rules with `gh api repos/{owner}/{repo}/rules/branches/<base>` and write down what they say.
The monitor passes the required-check list to its sweep as `--required`, so spell the names exactly as the checks
report them.

Example:

- The base branch is governed by a ruleset, not classic branch protection, so `reviewDecision` reads null.
- 1 approving review, counted as the latest review per author.
- Review threads must be resolved (`required_review_thread_resolution: true`).
- The approval must be newer than the last push (`require_last_push_approval: true`).
- Required checks, all green: `build`, `unit tests`, `lint`, `format`, `e2e-web Result`, `e2e-api Result`.
- Code scanning gate: errors, and high-or-higher.
- `strict_required_status_checks_policy: false`: the branch does not have to be up to date with the base.
- Auto-merge is off, so `gh pr merge --auto` is not a workaround.
- Merge method: merge commits. The repo merges the base into branches; it never rebases them.

## Reviewers

Example:

- When a PR has nobody requested, request the `web-reviewers` team:
  `gh api -X POST repos/{owner}/{repo}/pulls/<n>/requested_reviewers -f 'team_reviewers[]=web-reviewers'`.
- Measured: a merge-commit push dismissed the approval even though the ruleset reads
  `dismiss_stale_reviews_on_push: false`, and nobody was re-requested. A plain sync push on another PR kept its
  approval `APPROVED` but stale. Re-request the reviewer by hand after every push.

## Known noise: do not dispatch at these

Each entry says what it is, why it isn't the PR's fault, and whether it blocks a merge. Re-check an entry now and
then: noise gets fixed, and a fixed entry left on this list hides a real failure.

Example:

- **`publish-reports` failing**: two PRs raced to push the test-report site. Not a required check. Ignore it
  permanently.
- **`e2e-api Result` and its shards**: this used to read "red on the base since the suite landed". **No longer
  true; don't dismiss it.** It was fixed (the base's runs went green), and what it is now is one spec that flakes on a
  different test each run and survives all three retries, poisoning state for the rest of its worker. Rerun it, don't
  dismiss it. It isn't a required check, so it won't block a merge, but it isn't noise either: don't filter it out of
  what you report. Before blaming a PR, check whether a sibling PR passed the suite that same day.
- **Mid-stack PRs with no CI**: expected, see Stacks. Not fixable from the PR.
- **A field the upstream service never fills reads as `''`**: tests asserting the empty value are correct. Don't
  "fix" them.
- **A local format check flagging every file on Windows**: Git checks files out with CRLF and the formatter config
  says `endOfLine: lf`. Trust the CI log. Check locally with `--end-of-line auto`, and never mass `--write`.
- **About 60 lint warnings in the E2E mock data**: pre-existing, not the PR's.

## Red checks that aren't code bugs

Failures that look like code and aren't. Give each one its tell, so a fixer can rule it in or out from the log.

Example:

- **Every E2E suite red at once = the test secret, not the code.** All the E2E workflows boot the real API server
  through the test runner's web-server step, so the UI suites need the same service credential as the API suites.
  When the `E2E_API_SECRET` repo secret goes bad, both E2E required checks fail together on every PR in the repo:
  `e2e-api Result` and `e2e-web Result`. The tell, unmistakable, is zero tests executed and the
  server failing to start on an authentication error. The API shards fail in about 2 minutes; the UI shards look like a
  _different_ failure because they burn the whole web-server timeout first. Grep any failing job log for the
  authentication error before believing a code story. Someone with repo admin rotates the secret. A PR with a single
  red E2E check has a real failure; only the both-at-once shape points here.
- **A burst of UI spec failures across unrelated branches, inside the same few minutes = the shared test user.** The
  UI suites read the real current-user call for the shared test account, while the mocks assume that account belongs
  to one site. If someone switches the account to another site on the dev environment, every form reads as
  read-only and the edit specs fail. Environmental: rerun once the run finishes. The lasting fix is to mock the
  current-user call in those specs.

## Which commit each workflow tests

Say which workflows check out the merge commit and which check out the PR head, and where that's set. The monitor
reads this to know whether a base fix reaches a stale PR without a sync.

Example:

- `build`, `unit tests`, `lint`, and `format` run from `.github/workflows/check.yaml`, which sets
  `CHECKOUT_REF: ${{ github.sha }}`. On a `pull_request` event that's the merge commit, so they test the head merged
  into the base.
- Every E2E workflow checks out the PR **head**. A spec fix merged to the base doesn't reach a stale branch until it
  syncs.

## Stacks

Example:

- `check.yaml` and the E2E workflows filter `pull_request` on `branches: [main, releases/*]`. A PR based on another
  PR's branch therefore gets no checks at all, and pushing to it doesn't help. Its suite fires when its base moves.

## Gate and tooling quirks

Example:

- **The formatter is pinned** in `package.json`. A global install of a newer major formats differently and keeps CI
  red. Run it through `npx` from the worktree.
- **Lint `dependency-checks`:** a buildable lib that imports something needs the matching entry in that lib's own
  `package.json` `peerDependencies`. Add the entry. Don't `npm install`; it churns the lockfile.
- **Filtering tests:** `-t "<test name>"` filters correctly (`81 skipped, 1 passed`), while a path-pattern flag is
  inert here. Use `-t`. Reproducing a CI-only failure still needs the whole suite.
- **Windows, Git Bash:** its path conversion can rewrite a git `rev:path` argument such as
  `origin/main:.github/workflows/check.yaml` into a Windows path. Turn its path conversion off for that one command.

## Conventions

Example:

- No story ids in source, comments, JSDoc, tests, or templates. They belong in the PR title only, the way the
  profile's `prLink` writes them.
