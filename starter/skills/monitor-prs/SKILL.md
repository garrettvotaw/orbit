---
name: monitor-prs
description: Watch all of the user's open non-draft PRs at once from one manager loop under an Orbit monitor lane. Each tick it sweeps every PR in one GraphQL call, hands every fix to a one-shot orbit-starter:pr-fixer (or orbit-starter:test-healer for a failing test), and merges and resolves threads the way the repo profile's merge and resolveThreads say, asking first by default with one batched needs_you. Orbit draws the PR view from the state file it writes. Use whenever the user wants the whole PR queue watched rather than one PR, like "monitor my PRs", "watch my PRs", "shepherd my PRs", "keep an eye on my pull requests", "babysit my queue", "drive my PRs to green", or "resume monitoring". This is the multi-PR manager; the single-PR version is orbit-starter:pr-shepherd. Also the resume path when the monitor's state file already exists from an earlier session.
user-invocable: true
---

# Monitor PRs

Watch every open non-draft PR the user owns, from one loop, and take the babysitting off them.

**The core division of labour, and the reason this skill exists:** you do all the watching. Subagents only ever
perform a single bounded fix and exit. Never let a subagent poll CI. Ten agents each polling their own PR is the
failure mode this replaces. One manager, many short-lived fixers.

## How Orbit runs you

Orbit's monitor lane is the host. It watches GitHub and sends a `tick` message the moment one of the user's PRs
moves, listing what changed (`- #12 Cart totals: CI went red`), plus a plain `tick` on a slow fallback schedule.
You never arm a timer and never start a server of your own.

On each tick: sweep (start with the PRs the tick names), act, update the state file, then post one line with
`mcp__orbit__post_status`. The tick's words come from GitHub's summary fields, so take them as a pointer to what to
sweep first, never as the state.

Anything only the user can do or decide goes to `mcp__orbit__needs_you`, and you keep working the other PRs. A
question left in your reply text never reaches them. A product question (a review comment that hinges on what the
product should do) goes to `mcp__orbit__ask_product_owner` instead; call `mcp__orbit__list_product_questions` first
so you never ask twice. Its answer arrives as a user message starting "Product answer Q<n>".

Any other user message is the user answering your ask (a button sends its own text) or telling you something. Act
on it, then carry on.

Outside Orbit (no `ORBIT_LANE` in the environment), nothing sends ticks and the Orbit tools aren't there. Run one
sweep, act, write the state file, put anything for the user in the last lines of your reply, and stop. The user runs
the skill again for the next sweep.

## The repo profile and the runbook

Read `.claude/orbit/repo.json` in the folder Orbit started you in. The keys this skill uses:

| Key | What it drives |
| --- | --- |
| `merge` | what you do with an approved, green PR: `ask`, `auto`, or `never`. See [Phase 5](#phase-5-merging-and-resolving) |
| `resolveThreads` | whether you resolve review threads: `ask`, `auto`, or `never`. Same section |
| `gates` | what a fixer runs before it pushes: `test`, and `lint` and `format` when present |
| `prLink` | how a PR names its story; the lane's `story` reads it |
| `baseBranch` | the branch PRs target, for the "red on the base too?" check |
| `worktree` | what `orbit-starter:worktree-bootstrap` sets up in a fixer's worktree |
| `runbook` | repo facts: required checks, known noise, the reviewer team, the merge method, false trails |

`maxOpenPrs` isn't yours. The PM caps how many PRs are open; you watch every one.

**A key left out is never an error.** `merge` or `resolveThreads` unset means `ask`. No `gates.lint` or
`gates.format`: the fixer skips that gate. No `runbook`: there's no repo list of required checks or known noise, so
take required checks from the base branch's rules (sum.js reads them) and treat every red as real until a rerun says
otherwise. With no profile at all, run as if every key were left out, and say so once in post_status.

Then read `references/github.md`, beside this file. It holds the GitHub lessons that apply to every repo: how
approvals really count, last-push approval, a required check that's missing rather than failed, which commit CI
tests, stacks, staleness. Several contradict what the GitHub API appears to tell you, and they will save you from
wrong conclusions. The runbook adds this repo's facts on top; the plugin's `docs/runbook-template.md` shows what one
holds.

## The scripts

They live in this skill's `scripts/` folder, under the base directory Claude Code shows when it loads this skill.
`<skill>` below stands for that directory.

- `node <skill>/scripts/bootstrap.js` finds the state file, seeds it if it's absent, and says whether you're
  resuming. `--state <path>` picks another file; `--repo owner/name` records a repo other than the one `gh` sees here.
- `node <skill>/scripts/sum.js --state <stateFile>` is the sweep. `--required "a,b"` names the required checks,
  PR numbers narrow it, and `--repo owner/name` points it at another repo. It sends `q.graphql` in one call.
- `node <skill>/scripts/tick.js <stateFile> <patch.json>` applies one update to the state file; `--tick` also counts
  the tick.

## Phase 0: Start (first turn of a session)

1. Run `bootstrap.js`. Under Orbit it reads the `stateFile` Orbit's config gives this lane, so the PR view Orbit draws
   reads the file you write. Outside Orbit it defaults to `~/.claude/reports/monitor-prs/state.json`. Either way the
   file sits outside the repo: never write state or scratch files into the working tree. A WARNING line means the
   file isn't the one Orbit reads; say so in post_status. If it says **resuming**, read the file for history
   (owners, dispatch times, notes, open asks), but re-poll everything live before trusting any of it.
2. Confirm `gh auth status`.
3. Read the profile, `references/github.md`, and the runbook when the profile names one.
4. Sweep (Phase 1), work every PR, and end the turn. The ticks take it from there.

## Phase 1: The sweep (every tick)

```bash
node <skill>/scripts/sum.js --state <stateFile> --required "<the runbook's required checks, comma-separated>"
```

Leave `--required` off when the runbook doesn't list them, and sum.js reads the base branch's ruleset and classic
protection instead. It covers every open non-draft PR the user authored plus every lane the state file still tracks,
in **one** GraphQL call (per-PR calls waste a tick), and it always fetches before it prints. Work the PRs the tick
names first, then the rest.

Per PR it prints: the merge state and `mergeable`; base and head, with the head commit's time; the latest decisive
review per author (approving, blocking, dismissed), with `OLDER-THAN-HEAD` on an approval the head commit postdates;
who's requested; the required checks green, red (with the run id behind each red one), and absent; other failing
checks; how many are still running; and each unresolved thread with its id, file and line, author, and whether the
PR author has answered it. The raw response lands in `graph.json` beside the state file when you need a thread's
full text.

A tick line that reads `owner/name#12` is a PR in another repo. Sweep it with `--repo owner/name` and set `repo` on
its lane.

**Do not trust `reviewDecision`.** It reads null even on an approved PR under rulesets. Read the actual approvals
and the ruleset gates, the way sum.js does.

If a lane you know moved looks untouched, check the fetch time and the head SHA sum.js printed against
`gh pr list` before you trust the sweep.

## Phase 2: The duplicate-dispatch guard

Before spawning anything, read the state file. For any lane with `owner` set and `bucket: "fixing"`:

- **Do NOT spawn a second agent for that PR.** Two agents on one branch clobber each other.
- To check in, SendMessage the existing agent by name.
- Re-dispatch only if `dispatchedAt` is more than 45 minutes old **and** the branch head hasn't moved. That means it
  died. Look at its worktree first: a local commit with a clean tree means it's mid-verify, not dead.

Name every fixer when you spawn it, and record that name as `owner` with `dispatchedAt: "now"` the moment you
spawn. When it reports, clear both.

## Phase 3: Triage, first match wins

1. Merged or closed → bucket `merged`, stop tracking.
2. Conflicting → confirm it first (`mergeable` lags; github.md has the `git merge-tree` check), then dispatch
   `orbit-starter:pr-fixer` for the conflict.
3. CI failing → dispatch, **after** checking the runbook's known noise and whether the same check is red on the base
   branch (inherited breakage is not yours to fix; see Guardrails):

   ```bash
   gh api "repos/{owner}/{repo}/commits/<base>/check-runs?check_name=<check>" --jq '.check_runs[] | "\(.conclusion) \(.html_url)"'
   ```

   One red shard or one red attempt gets a rerun first (github.md, Flake or real). Then a failing test, unit or E2E,
   goes to `orbit-starter:test-healer` with the test and its CI log. Anything else (lint, format, build, types,
   dependencies, a cause nobody knows yet) goes to `orbit-starter:pr-fixer`.
4. CI still running → `waiting`, note progress. A required check that's absent while its shards run isn't failed.
5. Unresolved review threads → dispatch `orbit-starter:pr-fixer` to address them. Once the PR is approved, clearing
   them is your job (Phase 5), not a reason to stall.
6. Approved + green + mergeable → merge it, the way Phase 5 says.
7. Green + clean but unapproved → `waiting`. Nothing to do. Say so and move on. If nobody is requested at all,
   request the runbook's default reviewer team; if a push dropped an approval, re-request that reviewer
   (github.md, A push and the approval).
8. Stacked PR that cannot get CI → `blocked`.

## Phase 4: Delegation

Every fix goes to a one-shot subagent: `orbit-starter:pr-fixer` for a conflict, a red check that isn't a failing
test, or review threads; `orbit-starter:test-healer` for a failing test. pr-fixer already holds the standing rules
below (one bounded fix, no monitoring loop, real output, its worktree, its files, the gates). test-healer doesn't hold
the no-loop, real-counts, and dirty-tree rules, so write those three into its brief.

Name the worktree. Use the branch's existing one if `git worktree list` shows it (a branch is checked out in one
place only). Otherwise make one with `git worktree add` and run `orbit-starter:worktree-bootstrap` on it, so the gates
can run there.

Write briefs that are **specific, and honest about uncertainty**. What consistently paid off:

- State the exact files and lines, and the actual error text.
- Give the agent the _precedent_ to copy when one exists ("PR #X fixed this class of bug in commit `abc123`, read
  it first and mirror it"). That keeps two branches from solving one problem two ways.
- Flag known noise explicitly so it doesn't chase ghosts.
- Say **"do NOT open a monitoring loop: fix, verify, push, report, exit."** Every time.
- Demand real output: "do not claim green without pasting actual test counts."
- Name the worktree to use, and tell it to stop rather than stash if the tree is dirty.
- List the files it may edit: the PR's files the fix needs. Anything else, it stops and reports.
- If you hand it a hypothesis, say it's a hypothesis and to follow the evidence instead if it disagrees. **Agents
  that overturned the monitor's theory produced the best outcomes.**

A thread brief lists each thread (id, file and line, the comment) and marks it **settled** (a clear fix, a low-risk
nit, a factual question: the fixer posts its reply) or **open** (ambiguous: the fixer drafts a reply and brings it
back unposted). A test-healer brief carries the failing test, its log (`gh run view <run> --log-failed`), the command
that failed, the branch and worktree, and the files it owns.

**Model tiering: cheapest that will succeed.** Pass `model` on the Agent call.

| Tier | Use for |
| --- | --- |
| `haiku` | Purely mechanical, unambiguous target: moving or deleting comments, formatting, replying to a settled nit |
| `sonnet` | Known-shape work: base sync plus verify, or applying a fix whose pattern already exists in the repo |
| `opus` | Diagnosis of an unknown cause, semantic merge conflicts, anything touching business logic, an integration mapping, or an API contract |

The tell for `opus`: **does the brief contain a hypothesis the agent may need to overturn?** "Apply this known fix"
can go cheap. "Work out why this fails" cannot. Cheap models tend to accept the framing they're handed.

After any thread-fix dispatch, **audit each thread's `resolvedBy`** (sum.js prints it). A fixer once resolved a
reviewer's threads against an explicit instruction not to.

If test-healer quarantined a test and couldn't post its follow-up on the story, the user has to track it. Put it in
your next needs_you.

## Phase 5: Merging and resolving

**An approval is a green light. Act on it the tick you see it.** When a PR has a real approving review, clear its
threads and merge it, as far as the profile's `merge` and `resolveThreads` let you. Don't park it, don't come back
to the user for a sync-versus-approval judgement call, and don't wait for a reviewer to close their own threads.

### `merge` and `resolveThreads`

Both take `ask`, `auto`, or `never`, and **both default to `ask` when the profile leaves them unset.**

- `auto`: do it yourself the tick it's due, and say so in post_status ("merged #12", "resolved 3 threads on #14").
- `ask`: raise one needs_you that batches every PR waiting on that call (below), and act when the answer comes.
- `never`: never do it. Report the PR as ready (bucket `ready`, status "ready to merge, yours to merge") or its
  threads as yours or the reviewer's to resolve, and move on.

### The batched ask

With `ask`, never raise one ask per PR. Raise **one** needs_you for every PR waiting on the call:

- **One PR:** "Merge #12 (cart totals)? Approved, all required checks green." Buttons: "Merge #12", "Not yet".
- **Two to four:** the question lists each with a few words on where it stands. Buttons: "Merge all", one per PR
  ("Merge #12"), and "Not yet".
- **More than four:** the question lists them all. Buttons: "Merge all", "Not yet", and the four that have waited
  longest. The user can type any other number.

`resolveThreads: ask` works the same way: "Resolve #14's 3 threads", "Resolve all", "Not yet". A button holds 70
characters at most. Pass `story` when the ask is about one PR that names one.

Orbit keeps one open ask per lane: a new needs_you replaces the open one, and any message to the lane, a tick
included, clears it. So:

- Each tick, rebuild the ask from everything still waiting on the user and raise it again, unless nothing about those
  PRs changed since the user said "Not yet".
- When a thread call and a merge call are both waiting, ask about the threads first. The merge can't happen while
  required threads are open. Ask about the merge once they're resolved.
- An escalation (see Guardrails) goes at the top of the same question, and the buttons stay for the batch.
- When nothing is left waiting on the user, call `mcp__orbit__withdraw_needs_you`.

Record what you asked on each lane (`"ask": "merge"` or `"ask": "resolve"`), and set it back to null once settled.

When the answer comes:

- **"Merge all" or "Merge #12":** sweep those PRs again and re-check every gate below first. The answer can come
  ticks later, after a push. Then merge, bottom-up in a stack. A PR that no longer passes stays out, and you say why.
- **A reply naming some of the PRs:** do those. The rest go in the next ask.
- **"Not yet":** leave them `ready` and don't ask about them again until one changes (a push, a new review) or a new
  PR joins the batch. Record `"notYet"` with the answer's time on each lane.

The thread buttons work the same way, and resolving follows [Clearing threads](#clearing-threads).

### The gates, for every merge

Still merge only on:

- an actual approving review, read as the latest review per author, with no blocking reviewer;
- the approval newer than the last push;
- every required check green, ignoring known noise. The runbook's known-noise list is not to be trusted blindly: an
  entry can stop being noise (fixed, then flaking for a different reason) while the list lags. Before dismissing a red
  as noise, check it against the base branch's recent runs.

Zero unresolved threads remains a real ruleset gate where the repo has it, but you clear it yourself, as far as
`resolveThreads` lets you, rather than wait on it. The runbook lists this repo's exact gates. `mergeStateStatus:
BLOCKED` is the steady state under rulesets, so it's not a reason to skip a merge by itself: find out which gate is
unmet.

Merge with the method the runbook names (`gh pr merge <n>` with `--merge`, `--squash`, or `--rebase`). With none named
and the repo allowing more than one (`gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`),
ask which in the merge ask's question.

### Clearing threads

Unresolved threads on an approved PR are **your** job to clear, not a reason to stall. Two things still hold when you
clear them:

- **Reply before you resolve** if the thread was never answered (sum.js marks it UNANSWERED). A resolve with no
  answer buries the reviewer's point. Say what you did, or say why you declined, then resolve.
- **Say so in the report** if you resolved a thread whose substance you're declining rather than fixing, and name the
  thread. That's the one case where resolving loses information, so it goes in your post_status line and your reply,
  not only into the lane note.

Before the approval lands, don't resolve a reviewer's thread unless the fix is pushed and verified. Never resolve the
threads of a PR with a blocking reviewer: resolving needs a live approval. github.md has the reply and resolve
commands.

If `resolveReviewThread` gets refused by the permission classifier, that's a blocker only the user can clear. Say so
plainly in one line of needs_you and name the threads. Don't attempt a workaround.

### Staleness

Before merging a branch that is meaningfully behind the base, check **content overlap**, not just the behind-count:

```bash
mb=$(git merge-base origin/<head> origin/<base>)
comm -12 <(gh pr view <n> --json files --jq '[.files[].path][]' | sort) \
         <(git diff --name-only "$mb" origin/<base> | sort)
```

Zero overlap means the older CI probably still holds, so don't burn a sync. Overlap means sync and re-run first.
**But zero overlap is not proof of safety:** a merged PR that adds required steps to a shared flow breaks sibling specs
with no file overlap at all. See github.md, Staleness and Cross-PR interference.

### Stacks

Merge bottom-up in a stack. **Never delete a merged base branch while a child PR points at it**: it auto-closes the
child. After a base merges, check the child's base and its reviews (github.md, Stacks). A stack merge through
`merge-async` needs the user's explicit yes first, even with `merge: auto`, because it can trip a permission
classifier as a merge bypass. Verify the gates before you ask, so you can show the merge was legitimate.

## Phase 6: The state file

Orbit draws the PR view from the state file and redraws it whenever the file changes, so keep it current every tick.
Write a patch with the Write tool, then apply it:

```bash
node <skill>/scripts/tick.js <stateFile> <state file's folder>/patch.json --tick
```

Use tick.js rather than node one-liners in bash: apostrophes in notes break shell quoting. Pass `--tick` once per
tick, on the last write. tick.js keeps `activity` to the last 12 entries in ascending time order, stamps
`updatedAt`, and writes atomically so Orbit never reads half a file. Its header documents the patch format.

Lane shape:

```json
{ "pr": 12, "title": "...", "story": "<the story, as the PR names it>",
  "head": "...", "base": "main", "basePr": null, "behind": 0,
  "status": "waiting for team review", "bucket": "waiting",
  "owner": null, "dispatchedAt": null, "ask": null, "notYet": null, "note": "...",
  "stages": { "ci": {"state":"good","label":"4/4 required"},
              "review": {"state":"pending","label":"team requested"},
              "conflicts": {"state":"good","label":"clean"},
              "merge": {"state":"pending","label":"needs approval"} } }
```

Orbit reads `pr`, `title`, `story`, `bucket`, `status`, `note`, and `stages`; the rest is yours, for the guard and the
asks. Read `story` off the PR's title or body with the profile's `prLink`: with `Closes #{id}`, a "Closes #45" means
story 45. Leave it null when the PR names none.

Buckets: `attention` (needs the user) · `fixing` · `ready` · `waiting` · `blocked` · `merged`. Orbit hides `merged`.
Stage states: `good` `warn` `bad` `busy` `pending`, plus `none` and `unknown`, which Orbit draws as pending. Statuses
stay short and plain: "waiting for team review", "resolving merge conflicts", "needs <reviewer> to re-approve",
"blocked on base #11", "ready, asked you to merge".

## Phase 7: What to tell the user

**Only speak up when something actually changed**: a dispatch, a merge, an escalation, a new failure, or a finding
that changes what the user should do. Otherwise one post_status line: "tick N, no change". The PR view carries
routine status; don't narrate it back.

When you do report (the post_status line for the headline, your reply for the detail): lead with the conclusion,
cite the file and line or paste the command output, and say plainly what you did _not_ verify. If you got something
wrong earlier, correct it in a sentence and move on.

## Guardrails

- Never `git push --force`, `git reset --hard`, or `-X ours` / `-X theirs`.
- Never commit to the base branch. Never merge without the gates in Phase 5.
- Once the PR is approved, clear the threads and merge as Phase 5 and the profile say. Before the approval lands,
  don't resolve a reviewer's thread unless the fix is pushed and verified. Subagents never resolve anything either
  way; that stays with you.
- Don't fix another dev's breakage on the base branch from inside the user's PR. Surface it in the lane note and the
  status line.
- Escalate rather than guess on: semantic conflicts in business logic, ambiguous review comments, anything that
  failed the same way twice after a fix. Escalating means bucket `attention` and a needs_you that names the PR and the
  call. A comment that hinges on what the product should do is a product question instead.
- You don't move stories on the board. The PM does that when it sees the merge.
