# Port checklist: the PR monitor

What each rule of the monitor's sources became in the starter. One line per rule, so a reviewer can tick them against
the sources.

- `mp:N` is line N of the source monitor-prs skill, `rb:N` of its runbook reference. `boot:N`, `render:N`, and
  `serve:N` are lines of its three scripts. `sum:N`, `q:N`, and `tick:N` are lines of the scratch sweep files the skill
  relied on but didn't ship. All of them live in the source user's own config, outside this repo.
- Destinations: `skill` is `skills/monitor-prs/SKILL.md`, `github` is `skills/monitor-prs/references/github.md`,
  `template` is `docs/runbook-template.md`, `pr-fixer.md` is `agents/pr-fixer.md`. Scripts are
  `skills/monitor-prs/scripts/<name>`. "Profile" is the repo profile (`docs/repo-profile.md`).
- Rulings: (1) scripts the sweep runs are ported, the dashboard server, the renderer, and cron arming are dropped
  because Orbit's kickoff forbids them, and no script names a repo; (2) pr-fixer holds the fixer-brief rules plus the
  claimed-files and gates rules a lane follows; (3) keep every rule; (4) people become "the user", reviewer logins,
  team names, and check names come from the runbook, no company facts.

## Source monitor-prs skill

### Front matter and intro

- mp:2 · Name `monitor-prs` → skill `name: monitor-prs`.
- mp:3 · Description: all my non-draft PRs from one manager loop, delegates every fix to a one-shot subagent, merges approved-and-green → skill description, with merging and resolving "the way the profile's merge and resolveThreads say, asking first by default".
- mp:3 · Description: "with a live swim-lane dashboard" → skill description says Orbit draws the PR view from the state file. The dashboard itself is dropped: Orbit's host watches GitHub and sends ticks (ruling 1).
- mp:3 · Trigger phrases ("monitor my PRs" through "resume monitoring") → kept verbatim.
- mp:3 · The single-PR version is pr-shepherd → kept, `orbit-starter:pr-shepherd`.
- mp:3 · Resume path when the state file already exists → kept; the path is now Orbit's `stateFile` (Phase 0).
- mp:4 · `user-invocable: true` → kept.
- mp:7 · Watch every open non-draft PR I own, from one loop, take the babysitting off me → skill intro, "the user".
- mp:9-10 · You do all the watching, on a timer → skill intro. The timer is Orbit's ticks now (§ How Orbit runs you).
- mp:10-11 · Subagents perform a single bounded fix and exit → skill intro; pr-fixer.md intro.
- mp:11-12 · Never let a subagent poll CI; ten agents polling is the failure mode this replaces → skill intro; pr-fixer.md intro ("Never poll CI").
- mp:12 · One manager, many short-lived fixers → skill intro.

### Phase 0, bootstrap

- mp:16-17 · Working dir outside the repo; never write dashboard files into the working tree → skill Phase 0 step 1 ("never write state or scratch files into the working tree"); bootstrap.js keeps the state file wherever Orbit's config or the default says, never in the repo.
- mp:19-20 · Create the working dir and copy render.js and serve.js into it → creating it kept (bootstrap.js); the copy is dropped: Orbit's host watches GitHub and sends ticks, and draws the PR view itself (ruling 1).
- mp:20-21 · state.json exists means resuming: read it for history, re-poll everything live before trusting it → skill Phase 0 step 1; bootstrap.js prints RESUMING and the same warning.
- mp:22 · Confirm `gh auth status` → skill Phase 0 step 2.
- mp:23-24 · Read the runbook: repo gates, known noise, gotchas; it saves wrong conclusions → skill § The repo profile and the runbook and Phase 0 step 3. The GitHub-general half is now `references/github.md`, read always; the repo half is the profile's `runbook`, read when set.
- mp:25 · Ask the poll interval only if not given; default 20 minutes → dropped: Orbit's host watches GitHub and sends ticks (its `everyMinutes` and `watchSeconds` set the cadence).
- mp:26-29 · Arm CronCreate, recurring, off-:00 minute, with a prompt restating the manager rules → dropped: Orbit's host watches GitHub and sends ticks (ruling 1).
- mp:30-31 · Skip the cron when `ORBIT_LANE` is set → kept in substance: the port never arms one. Outside Orbit it runs one sweep and stops (§ How Orbit runs you).
- mp:31-34 · Orbit sends `tick` the moment a PR moves, listing what changed, plus a plain `tick` on a slow fallback → skill § How Orbit runs you.
- mp:34-35 · On each tick: sweep (start with the PRs the tick names), act, update state.json, post one line with post_status → skill § How Orbit runs you and Phase 1 ("Work the PRs the tick names first").
- mp:35-37 · What only I can clear (a merge call, a thread only I can resolve) goes to needs_you; a question in reply text never reaches me → skill § How Orbit runs you; Phase 5 § The batched ask.
- mp:38-39 · Start `node serve.js` in the background on port 4321 and give me the URL → dropped: Orbit's host watches GitHub and sends ticks (ruling 1).
- mp:39-40 · Skip that under `ORBIT_LANE`; Orbit renders the PR view from state.json → skill Phase 6 ("Orbit draws the PR view from the state file").

### Phase 1, the sweep

- mp:44-47 · `gh pr list --author "@me" --state open --json … --limit 50` → sum.js (`prsToSweep`, same flags, `-R` the repo).
- mp:49 · Non-draft only → sum.js filters drafts; a PR back to draft prints as not monitored.
- mp:49-50 · One GraphQL call for all PRs at once; per-PR calls waste a tick → skill Phase 1; sum.js builds one aliased query from `q.graphql`.
- mp:50-51 · Fetch reviews, reviewThreads, reviewRequests, mergeable, mergeStateStatus → q.graphql.
- mp:51 · Get the check rollup per PR separately → changed: the rollup rides in the same GraphQL call (the scratch query already did, q:28-34). github.md § A missing required check keeps the per-PR `gh pr view --json statusCheckRollup` command for a PR's full rows.
- mp:53-54 · Don't trust `reviewDecision`; it reads null on an approved PR; read actual approvals and the ruleset gates → skill Phase 1; github.md § Rulesets.

### Phase 2, the duplicate-dispatch guard

- mp:58-59 · Before spawning, load state.json; look at lanes with `owner` set and `bucket: "fixing"` → skill Phase 2.
- mp:61-62 · Don't spawn a second agent for that PR; two agents on one branch clobber each other → skill Phase 2.
- mp:63 · Check in by SendMessage to the existing agent by name → skill Phase 2.
- mp:64-65 · Re-dispatch only if `dispatchedAt` is over 45 minutes stale and the head hasn't moved → skill Phase 2.
- mp:65-66 · Look at the worktree first: a local commit with a clean tree is mid-verify, not dead → skill Phase 2.
- mp:68 · Record `owner` and `dispatchedAt` the moment you spawn → skill Phase 2 (with "name every fixer", since the guard messages it by name, and "when it reports, clear both").

### Phase 3, triage

- mp:72 · Merged or closed → bucket `merged`, stop tracking → skill Phase 3 step 1; sum.js stops sweeping merged and closed lanes.
- mp:73 · Conflicting → dispatch a conflict fixer → skill Phase 3 step 2, `orbit-starter:pr-fixer`, after confirming with `git merge-tree` (rb:287-292).
- mp:74-75 · CI failing → dispatch, after checking known noise and whether the same check is red on main (inherited breakage isn't yours) → skill Phase 3 step 3, with the base-branch check-runs command. A failing test goes to `orbit-starter:test-healer`, anything else to `orbit-starter:pr-fixer`.
- mp:76 · CI still running → `waiting`, note progress → skill Phase 3 step 4.
- mp:77 · Unresolved review threads → dispatch a comment-addresser → skill Phase 3 step 5, `orbit-starter:pr-fixer` running `orbit-starter:address-pr-comments` (pr-fixer.md § The fix).
- mp:78 · Approved + green + mergeable → merge it (Phase 5) → skill Phase 3 step 6, as the profile's `merge` says.
- mp:79 · Green and clean but unapproved → `waiting`; nothing to do; say so and move on → skill Phase 3 step 7.
- mp:80 · Stacked PR that can't get CI → `blocked` → skill Phase 3 step 8.

### Phase 4, delegation

- mp:84-85 · Write briefs that are specific and honest about uncertainty → skill Phase 4; pr-fixer.md § Read first.
- mp:87 · State the exact files and lines and the actual error text → skill Phase 4; pr-fixer.md § Read first.
- mp:88-90 · Give the precedent to copy ("PR #X fixed this in commit abc123, mirror it") so two branches don't solve one problem two ways → skill Phase 4; pr-fixer.md § Read first.
- mp:91 · Flag known noise explicitly so it doesn't chase ghosts → skill Phase 4; pr-fixer.md § Read first.
- mp:92-93 · Say "do NOT open a monitoring loop: fix, verify, push, report, exit." every time → skill Phase 4; pr-fixer.md intro; written into every test-healer brief (skill Phase 4).
- mp:94 · Demand real output: no green without pasted test counts → skill Phase 4; pr-fixer.md § Gates; written into test-healer briefs.
- mp:95 · Name the worktree; stop rather than stash if the tree is dirty → skill Phase 4 (with how to find or make the worktree); pr-fixer.md § The worktree; written into test-healer briefs.
- mp:96-97 · A hypothesis is labelled as one, with "follow the evidence instead if it disagrees" → skill Phase 4; pr-fixer.md § Read first.
- mp:97-98 · Agents that overturned my theory produced the best outcomes → skill Phase 4 ("the monitor's theory"); pr-fixer.md ("a good outcome, not a failure").
- mp:100 · Model tiering, cheapest that will succeed; pass `model` on the Agent call → skill Phase 4. pr-fixer.md is `model: inherit` so the per-dispatch pick wins.
- mp:104 · `haiku`: purely mechanical, unambiguous target (moving or deleting comments, formatting, replying to a settled nit) → skill Phase 4 table.
- mp:105 · `sonnet`: known-shape work (base sync plus verify, a fix whose pattern exists) → skill Phase 4 table.
- mp:106 · `opus`: unknown cause, semantic conflicts, business logic, or two stack-specific contracts → skill Phase 4 table, as "an integration mapping, or an API contract" (Global Constraints).
- mp:108-110 · The tell for opus: does the brief hold a hypothesis the agent may need to overturn; cheap models accept the framing → skill Phase 4.
- mp:112-113 · After any comment-fix dispatch, audit `resolvedBy`; a fixer once resolved threads against instructions → skill Phase 4; pr-fixer.md § The fix ("Never resolve a thread").

### Phase 5, merging

- mp:117 · An approval is a green light; act on it the tick you see it → skill Phase 5 opening.
- mp:117-119 · With a real approving review, resolve every open thread and merge → skill Phase 5, now "as far as the profile's `merge` and `resolveThreads` let you". With both unset (`ask`), one batched needs_you per call (Review Focus 3, § The batched ask). `auto` does it and says so in post_status. `never` reports the PR ready.
- mp:119-120 · Don't park it, don't come back for a sync-versus-approval call, don't wait for a reviewer to close threads → skill Phase 5 opening.
- mp:120-121 · The dated story of the PR that sat approved and green while the source user resolved threads by hand → its point is the rule at mp:117-120. The date, the PR number, and the person are dropped: Global Constraints (nothing specific ships).
- mp:123-124 · Unresolved threads are your job to clear, not a reason to stall → skill § Clearing threads; Phase 3 step 5.
- mp:126-128 · Reply before you resolve if the thread was never answered; say what you did or why you declined → skill § Clearing threads; sum.js marks each thread answered or UNANSWERED; github.md § Commands has the reply mutation.
- mp:129-131 · If you resolved a thread whose substance you're declining, say so and name it; it goes in front of me, not the dashboard note → skill § Clearing threads (the post_status line and the reply).
- mp:133-134 · Merge only on an approving review, the approval newer than the last push, every required check green ignoring known noise → skill § The gates; sum.js computes all three.
- mp:134-136 · Don't trust the runbook's known-noise list blindly (its fixed-then-flaking entry) → skill § The gates, generalized; template § Known noise keeps the example.
- mp:136-137 · Zero unresolved threads is a real ruleset gate, but you clear it rather than wait → skill § The gates.
- mp:137 · The runbook lists the repo's exact gates → skill § The gates; template § Merge gates.
- mp:139-141 · `resolveReviewThread` refused by the permission classifier is a blocker only I can clear; one line, name the threads, no workaround → skill § Clearing threads, through needs_you.
- mp:143-150 · Before merging a branch far behind main, check content overlap with the `comm -12` recipe → skill § Staleness, with `origin/<base>` for `origin/main`.
- mp:152-153 · Zero overlap: older CI probably holds, don't sync. Overlap: sync and re-run first → skill § Staleness.
- mp:153-155 · Zero overlap isn't proof: a PR adding required steps to a shared flow breaks siblings → skill § Staleness; github.md § Staleness and § Cross-PR interference.
- mp:157 · Merge bottom-up in a stack → skill § Stacks; § The batched ask ("bottom-up in a stack").
- mp:157-158 · Never delete a merged base branch while a child points at it; it auto-closes the child → skill § Stacks; github.md § Stacks.

### Phase 6, dashboard

- mp:162 · Edit state.json, then `node render.js` → the edit is kept through tick.js (skill Phase 6); render.js is dropped: Orbit's host watches GitHub and sends ticks, and redraws from the state file itself.
- mp:162-163 · Keep `activity` to about 12 entries, ascending time order → tick.js keeps the last 12 and appends; skill Phase 6.
- mp:165-174 · Lane shape (pr, title, story, head, base, basePr, behind, status, bucket, owner, dispatchedAt, note, four stages) → skill Phase 6, same shape plus `ask` and `notYet` for the batched ask. `story` reads the PR through the profile's `prLink` instead of one tracker's id form.
- mp:176-177 · Buckets attention, fixing, ready, waiting, blocked, merged → skill Phase 6, plus "Orbit hides merged".
- mp:177 · Stage states good, warn, bad, busy, pending, none, unknown → skill Phase 6, plus "none and unknown draw as pending" (Orbit's parser).
- mp:178-179 · Statuses short and plain, with examples → skill Phase 6; the one naming a reviewer became "needs <reviewer> to re-approve" (ruling 4).
- mp:181-182 · Use tick.js as an updater rather than node one-liners; apostrophes break shell quoting → skill Phase 6; tick.js reads a patch file the Write tool wrote.

### Phase 7, what to tell me

- mp:186-187 · Only speak up when something changed (dispatch, merge, escalation, new failure, a finding that changes what I do) → skill Phase 7.
- mp:187-188 · Otherwise one line: tick N, no change; the dashboard carries routine status → skill Phase 7, as the post_status line; "the PR view" for the dashboard.
- mp:190-191 · Lead with the conclusion, cite file and line or paste output, say what you did not verify → skill Phase 7.
- mp:191-192 · If you got something wrong, correct it in a sentence and move on → skill Phase 7.

### Guardrails

- mp:196 · Never `git push --force`, `git reset --hard`, or `-X ours/theirs` → skill § Guardrails; pr-fixer.md § Never.
- mp:197 · Never commit to main; never merge without the Phase 5 gates → skill § Guardrails ("the base branch"); pr-fixer.md § Never.
- mp:198-199 · Once approved, resolve every thread and merge; before approval, don't resolve unless the fix is pushed and verified → skill § Guardrails and § Clearing threads, under the profile's `resolveThreads`.
- mp:199-200 · Subagents never resolve anything either way; that stays with you → skill § Guardrails; pr-fixer.md § The fix and § Never.
- mp:201 · Don't fix another dev's breakage on main from inside my PR; surface it → skill § Guardrails and Phase 3 step 3; pr-fixer.md § Never.
- mp:202-203 · Escalate rather than guess on semantic conflicts in business logic, ambiguous review comments, anything that failed the same way twice → skill § Guardrails (bucket `attention` plus needs_you); pr-fixer.md § Never and § Gates.

## Source runbook

### Title and merge gates

- rb:1 · Runbook title naming the repo → template title and intro; the repo name is dropped (Global Constraints).
- rb:3-4 · Hard-won facts; several contradict the API; dated observations are measured, not inferred → github.md intro; template intro ("date what you measured").
- rb:6-12 · The base branch is governed by a ruleset; read it with `gh api …/rules/branches/main` → github.md § Rulesets, with `{owner}/{repo}` and `<base>`; template § Merge gates.
- rb:14-16 · `reviewDecision` reads null under rulesets; never read null as not approved; check the real gates → github.md § Rulesets; skill Phase 1.
- rb:18-22 · Don't compute approval as `select(.state=="APPROVED")`; a later CHANGES_REQUESTED is ignored (measured, with a reviewer's login) → github.md § Rulesets; the login and PR are dropped (ruling 4).
- rb:24-29 · Take the latest review per author (the jq) → github.md § Rulesets; sum.js `latestReviews`.
- rb:31-32 · Any blocking reviewer: not mergeable however green, and its threads must not be resolved → github.md § Rulesets; skill § Clearing threads.
- rb:34 · 1 approving review, by the `$latest` computation → template § Merge gates example; github.md gate list.
- rb:35 · `required_review_thread_resolution: true` → template example; github.md gate list.
- rb:36 · `require_last_push_approval: true` → template example; github.md gate list.
- rb:37-39 · Seven required checks by name → template example, with made-up names; the monitor passes the runbook's list to sum.js as `--required`.
- rb:40 · Code-scanning gate (errors, high-or-higher) → template example; github.md gate list.
- rb:41-42 · `strict_required_status_checks_policy: false`; the trap behind staleness → template example; github.md gate list.
- rb:44-45 · `mergeStateStatus: BLOCKED` is the steady state; find which gate is unmet → github.md § Rulesets; skill § The gates.
- rb:47-55 · The code-scanning check can sit queued after the analysis passed; merge refused; don't rerun; retry when it completes; NEUTRAL satisfies → github.md § Rulesets.
- rb:55-56 · Even then the first merge can be refused; REST `mergeable_state` clean and a retry about 20s later merged → github.md § Rulesets.
- rb:56-57 · Auto-merge is disabled here, so `--auto` is no workaround → template § Merge gates example; github.md ("where the repo has auto-merge on; the runbook says").

### Approvals and pushes

- rb:59-62 · A push DID dismiss the approval despite `dismiss_stale_reviews_on_push: false` (measured, a reviewer named) → github.md § A push and the approval; template § Reviewers example. The login is dropped.
- rb:62-63 · `reviewRequests` came back empty: not auto-re-requested → github.md ("Nobody gets re-requested").
- rb:63-64 · Treat the approval as gone; re-request the reviewer by hand after every push → github.md; skill Phase 3 step 7.
- rb:64-66 · The two observations disagree; merge commit vs plain push is the leading suspect → github.md ("the leading suspect, not a proven one").
- rb:68-72 · A push that doesn't dismiss still invalidates under last-push approval; the PR looks approved and isn't mergeable → github.md § A push and the approval.
- rb:72-73 · Compare `submittedAt` to the head commit's `committedDate`; sum.js prints both → github.md; sum.js marks `OLDER-THAN-HEAD`, with the commit-time-not-push-time caveat.
- rb:73-75 · Nothing dismissed means no auto re-request; the `requested_reviewers` command → github.md, with `{owner}/{repo}`.
- rb:76-77 · Older measurement: base main lost its approval on push, a user-branch base kept it → github.md ("a PR based on the default branch … one based on a user branch").
- rb:79-84 · Default reviewer team when nobody's requested, and the command naming the team → github.md (`<team slug>` from the runbook); template § Reviewers example; skill Phase 3 step 7.

### Known noise

- rb:86 · Known noise: do NOT dispatch agents at these → template § Known noise heading; skill Phase 3 step 3 reads it.
- rb:88-89 · The report-cleanup job fails on a gh-pages push race; not required; ignore permanently → template example (`publish-reports`).
- rb:90-94 · A suite once dismissed as broken on main was fixed; don't dismiss it any more (the source user caught it) → template example; the person is dropped (ruling 4).
- rb:95-97 · One spec flakes on a different test each run and survives all retries; "survived retries" doesn't prove determinism → template example; github.md § Flake or real.
- rb:98-99 · Measured: two PRs died on different lines while a third passed the same suite → template example, generalized (no PR numbers).
- rb:100-102 · Rerun it, don't dismiss it; not required so it won't block, but don't filter it out of reports → template example.
- rb:102-103 · Before blaming a PR, check whether a sibling passed that suite the same day → template example; github.md § Flake or real.
- rb:104 · Mid-stack PRs with no CI are expected → template example; github.md § Stacks.
- rb:105-106 · A field upstream never fills resolves to `''`; tests asserting empty are right; don't fix them → template example, the field and system names dropped (Global Constraints).
- rb:107-108 · Local format check flags every file on Windows (CRLF vs `endOfLine: lf`); trust CI; `--end-of-line auto`; never mass `--write` → template example.
- rb:109 · About 67 pre-existing lint warnings in E2E mock data → template example ("about 60").

### Flake or real, and reruns

- rb:113-114 · Flake is one shard or one attempt; real is deterministic across a fresh rerun, uniform duration, siblings passing → github.md § Flake or real; skill Phase 3 step 3.
- rb:116-118 · "Failed all 3 retries" isn't proof; retries share a container; `gh run rerun <id> --failed` once is decisive → github.md § Flake or real.
- rb:118-119 · Measured: specs that failed all retries and the fresh rerun were real → github.md, generalized.
- rb:121-126 · Reruns return "already running" (403) while any job is outstanding, including a serialized Pages deploy chain → github.md § Flake or real.
- rb:126-128 · Measured run with one failed shard and the deploy chain queued → github.md, generalized.
- rb:128-131 · Confirm by listing the run's jobs; zero failed shards plus failed ones back in progress means a rerun took; only deploy jobs outstanding means wait → github.md, with the jobs command.

### Every E2E suite red at once

- rb:133-142 · Every E2E suite red at once is the cloud credential: UI suites boot the server too; three checks fail on every PR; how the credential is wired, with file and line → template § Red checks example (a generic `E2E_API_SECRET`); github.md § Every suite red at once, generalized. The provider, file paths, and variable names are dropped (Global Constraints).
- rb:144-150 · The tell: zero tests run, the server failed to start on an authentication error (the error text and an app id) → template example and github.md, as "an authentication error". The error codes and app id are dropped (Global Constraints).
- rb:152-153 · API shards fail in about 2 minutes; UI shards burn the full web-server timeout and look different → template example; github.md.
- rb:153-154 · Grep any failing log for the credential error before believing a code story → template example; github.md.
- rb:154-156 · Measured window, and the server suite failing on the same commit, which no client change explains → kept as the rule at rb:153-154; the dated window is dropped (Global Constraints).
- rb:158 · Not dispatchable, not fixable in code; repo admin rotates the secret → github.md; template example.
- rb:159-161 · Checks before the break stay green and count; don't push, sync, or rerun an otherwise-green PR; merge on the existing green if an approval lands → github.md.
- rb:163-166 · Secrets are injected at job start, so a job queued during the outage and started after the fix reads the new value: a free before and after → github.md.
- rb:166-168 · Measured run bracketing the rotation → github.md, generalized.
- rb:168-171 · Before burning a rerun to test the secret, check the run's jobs for one started after the last rejection; then rerun the required runs on the head, no push → github.md.
- rb:173-175 · One red required check is not this bug; only the several-at-once shape → template example; github.md ("One red required check alone is not this").

### Shared test user

- rb:177-185 · Specs red across branches in one window: the shared test user's live site was switched, so every form reads read-only; the tell is a burst across unrelated branches → template § Red checks example, the account, site, and spec names dropped (Global Constraints); github.md § Flake or real (the burst rule).
- rb:186-187 · Environmental: rerun once the run finishes; the lasting fix is mocking the current-user call → template example; github.md.

### Stacks

- rb:191-194 · Mid-stack PRs get no CI: workflow branch filters are on the PR's base; pushing to the head doesn't help → github.md § Stacks; template § Stacks example.
- rb:194-195 · What fires the child's suite is the base branch moving → github.md § Stacks.
- rb:197-199 · A stack doesn't unwind: the child doesn't retarget; `gh pr edit --base` refuses "part of a stack" → github.md § Stacks.
- rb:200-201 · The child is then unmergeable → github.md § Stacks.
- rb:205-207 · A normal merge orphans the child; the fix is a replacement PR; approvals and threads don't carry → github.md § Stacks.
- rb:208-210 · `merge-async` cascades the retarget, keeps review state, fires the suite → github.md § Stacks.
- rb:212-216 · The cascade can rebase the child and dismiss its approval; re-read head and reviews, re-request by hand → github.md § Stacks; skill § Stacks.
- rb:218-222 · `merge-async` doesn't always cascade; check the child's `baseRefName`; `PATCH … -f base=` retargets and dismisses → github.md § Stacks.
- rb:224-227 · A non-stack child doesn't retarget; `gh pr edit --base` errors, `PATCH` works, dismisses the approval, no CI until a sync push → github.md § Stacks.
- rb:229-231 · "part of a stack and must be merged using the asynchronous merge REST API" means use `merge-async` → github.md § Stacks.
- rb:233-237 · The `merge-async` endpoint, body, and poll → github.md § Stacks.
- rb:239-241 · `merge-async` may trip a permission classifier; get explicit user authorization first; verify the gates before → github.md § Stacks; skill § Stacks (even with `merge: auto`).
- rb:243-244 · Never delete a merged base branch while a child points at it → github.md § Stacks; skill § Stacks.
- rb:246-250 · A base-targeting PR carrying another open PR's head merges both; only when the top approval covers the diff and the user okayed skipping bottom-up → github.md § Stacks ("the user").
- rb:252-256 · A stack-merge conflict burst: `git patch-id` separates duplicate arrivals; cross-check the differing files → github.md § Stacks; pr-fixer.md § The fix.
- rb:256-258 · Never blanket `-X ours`; a spot where the base had to win would silently revert a fix → github.md § Stacks; pr-fixer.md § The fix. The file name is dropped (Global Constraints).

### Staleness

- rb:262-265 · With strict checks off GitHub merges on CI computed against an old main; a branch passed locally and went red because main removed an element → github.md § Staleness, generalized (no PR, no component library).
- rb:267-269 · Check content overlap rather than behind-count; zero overlap: don't sync; overlap: sync and rerun → github.md § Staleness; skill § Staleness.
- rb:271-277 · Zero overlap isn't proof: main added required steps to a flow and a sibling's spec helper drove the old walk; sync and rerun every sibling that automates the flow → github.md § Staleness, generalized.
- rb:279-280 · Don't bulk-sync branches not near merging: runner minutes, and it resets approvals → github.md § Staleness.

### Windows and tooling

- rb:284-285 · Git Bash mangles a `rev:path` argument; turn its path conversion off → template § Gate and tooling quirks, without the env var's name (ruling 4).
- rb:286 · `gh pr view --json X --jq` doesn't accept `--arg`; build the filter inline → github.md § gh quirks.
- rb:287-291 · `mergeable` lags reality; confirm with `git merge-tree --write-tree --name-only`; a bare tree hash means clean → github.md § mergeable lags; skill Phase 3 step 2.
- rb:291-292 · A REST poke doesn't clear the flag; close and reopen would, but that's outward-facing → github.md § mergeable lags.
- rb:293 · The repo pins its formatter; a global newer major reformats and keeps CI red → template § Gate and tooling quirks, with no version (Global Constraints).
- rb:294-296 · Lint `dependency-checks`: a buildable lib's import needs its own peerDeps entry; add it, don't `npm install` → template § Gate and tooling quirks.
- rb:297-298 · No story ids in source, comments, JSDoc, tests, templates; PR title only → pr-fixer.md § Never; template § Conventions.

### Cross-PR interference

- rb:302-306 · Two PRs green alone can break combined: one adds a required step to a shared flow; the originator can only patch its own specs → github.md § Cross-PR interference.
- rb:308-309 · Fixing that class: reuse locator patterns from a spec CI proves green; fix specs, not the app; never skip, fixme, or loosen → github.md § Cross-PR interference; pr-fixer.md § The fix.
- rb:311-312 · `✓ 31` / `✘ 32` are shard-wide indices, not per-file counts → github.md § Shard indices.

### The sweep's own trap

- rb:314-323 · sum.js reads only `graph.json`, so writing the sweep anywhere else re-summarizes the last tick with no error → fixed in the script: sum.js fetches on every run and prints the fetch time, so it can't summarize an old snapshot. It still saves `graph.json` beside the state file for detail.
- rb:325-327 · Measured: a stale sweep showed a merged PR as open and an old head as green → kept as the reason for the fix above; the measurement is dropped (Global Constraints).
- rb:327-330 · The tell is two impossibilities at once; cross-check the head SHA against `gh pr list`; check graph.json's time if frozen → skill Phase 1 ("check the fetch time and the head SHA sum.js printed against `gh pr list`").

### A missing required check

- rb:334-336 · Aggregator `… Result` checks materialize only after their shards finish; the row is absent, with no placeholder → github.md § A missing required check.
- rb:338-341 · Measured: every other check green while two aggregators were missing and a shard ran → github.md, generalized.
- rb:343-345 · Never read a required check missing from the rollup as unmet; read the shard rows; a name filter under-reports → github.md; skill Phase 3 step 4; sum.js lists ABSENT apart from RED.
- rb:347-350 · The rollup command that shows shards and coerces both shapes → github.md, verbatim.
- rb:352-353 · `.name` is null on a StatusContext; fall back to `.context` → github.md; sum.js.

### Which commit CI tests

- rb:357-361 · The E2E workflows check out the PR head, so a spec fix on main doesn't reach a stale PR (measured) → github.md § Which commit CI tests, generalized; template § Which commit each workflow tests example.
- rb:361-364 · A spec fix merged to main the branch lacked; every branch passing that day carried it → github.md, generalized.
- rb:364-366 · A rerun can't fix it; the tell; check `git merge-base --is-ancestor`, then sync and push → github.md.
- rb:370-374 · `CHECKOUT_REF: ${{ github.sha }}` is the merge commit on `pull_request`; those jobs test head merged into main → github.md; template example (the workflow file is the example's).
- rb:377-380 · A green local run on the branch alone proves nothing; a fixer can honestly report all green and CI fail (measured) → github.md, generalized.
- rb:381-383 · Non-strict checks are less dangerous for these checks; semantically wrong auto-resolved merges aren't protected → github.md.
- rb:384-389 · Reproduce a CI-only failure: `git merge origin/main --no-commit --no-ff`, run, `git merge --abort` → github.md; pr-fixer.md § The fix (with `<base>`).
- rb:391-392 · Reproducing needs the whole suite; order- or state-dependent tests pass alone → github.md; pr-fixer.md § The fix.
- rb:393-394 · `-t "<name>"` filters correctly here, unlike the path-pattern flag → template § Gate and tooling quirks.

## Source scripts

### bootstrap.js

- boot:2 · Idempotent, safe to re-run on resume → bootstrap.js header.
- boot:4-5 · Usage, with `--repo owner/name` → kept, plus `--state <path>`; skill § The scripts.
- boot:7 · Copies render.js and serve.js out of the skill → dropped: Orbit's host watches GitHub and sends ticks (ruling 1).
- boot:8 · Seeds an empty state.json if there isn't one → kept.
- boot:8-9 · Doesn't poll GitHub; the skill does and writes the lanes → kept.
- boot:16 · Working dir `~/.claude/reports/pr-shepherd` → under Orbit, the `stateFile` Orbit's config names for this lane (from `ORBIT_LANE` and `ORBIT_CONFIG` or the default config path); outside Orbit, `~/.claude/reports/monitor-prs/state.json`; `--state` overrides. It warns when Orbit's config doesn't name a file.
- boot:19 · Default repo hard-coded → dropped: `--repo`, else the state file's, else `gh repo view` (ruling 1).
- boot:21 · Create the working dir → kept (the state file's folder).
- boot:23-25 · Copy the dashboard files → dropped: Orbit's host watches GitHub and sends ticks (ruling 1).
- boot:30-47 · Seed `updatedAt`, `tick`, `repo`, `activity`, `lanes` → kept. `nextCheckAt` and `pollMinutes: 20` → dropped: Orbit's host watches GitHub and sends ticks, on its own schedule.
- boot:49 · Print workDir, resuming, repo, and the dashboard URL → kept with the state file and where it came from; the URL is dropped (ruling 1).
- boot:50-55 · On resume, print the last tick, when, the lane count, and "re-poll everything live" → kept. A state file that isn't valid JSON now stops with a message instead of a stack trace.

### render.js

- render:2 · Render state.json to dashboard.html after every state update → dropped: Orbit's host watches GitHub and sends ticks, and draws the PR view from the state file.
- render:15-22 · Bucket order, labels, and hints → dropped, same reason; Orbit's ring has its own order for the same bucket keys.
- render:24-33 · Stage glyphs; an icon always paired with a label, colour never alone → dropped, same reason.
- render:35-42 · Bucket chips → dropped, same reason.
- render:44-49 · Stage order CI, Review, Conflicts, Merge → dropped, same reason; the lane shape keeps the four stage keys.
- render:54-61 · KPI counts per bucket → dropped, same reason.
- render:63 · PR links built from the state file's `repo` → dropped, same reason; Orbit builds them the same way, so bootstrap.js records `repo`.
- render:65-67 · Waiting lanes render compact, two to a row → dropped, same reason.
- render:82-84 · A stacked lane shows "on #basePr" → dropped, same reason; `basePr` stays in the lane shape.
- render:86-91 · A stale chip once a branch is 20 or more behind → dropped, same reason; `behind` stays in the lane shape.
- render:93-109 · Lane card: story, status chip, owner tag, an expandable "why" note → dropped, same reason; Orbit shows the note.
- render:122-130 · Activity feed newest first, collapsed by default → dropped, same reason.
- render:174-175 · Header with repo, tick, updated time, next check → dropped, same reason.
- render:200-209 · Remember the open feed and the scroll position across reloads → dropped, same reason.
- render:211-217 · Reload only when `updatedAt` changes → dropped, same reason; Orbit re-reads on a file change, and tick.js stamps `updatedAt`.

### serve.js

- serve:1-2 · A static server because `file://` is blocked for tooling → dropped: Orbit's host watches GitHub and sends ticks (ruling 1).
- serve:8 · Port 4321 → dropped, same reason.
- serve:14-15 · `/` serves the dashboard; only basenames in the folder → dropped, same reason.
- serve:22-23 · `no-store` caching → dropped, same reason.

### sum.js (scratch)

- sum:1 · Reads `./graph.json` → sum.js fetches on every run (rb:314-323) and, with `--state`, saves the response as `graph.json` beside the state file.
- sum:2 · Required checks hard-coded → `--required` from the runbook, else the base branch's ruleset and classic protection; with neither, every check counts and it says so.
- sum:4-5 · A merged or closed PR prints one line with its merge time → kept, with the title.
- sum:6 · Reads the head commit → kept.
- sum:7-8 · Latest review per author, skipping COMMENTED → kept, sorted by `submittedAt` and counting only APPROVED, CHANGES_REQUESTED, and DISMISSED, so a pending review never counts.
- sum:9-11 · Approving, blocking, and dismissed reviewers → kept; an approval older than the head commit is marked `OLDER-THAN-HEAD` (rb:72-73).
- sum:12-14 · Check rows keyed `name || context`, valued `conclusion || status || state` → kept.
- sum:15 · Red is FAILURE, ERROR, TIMED_OUT → kept, plus CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE, and STALE.
- sum:16 · Running is IN_PROGRESS, QUEUED, PENDING, WAITING → kept as anything neither green nor red.
- sum:17-19 · Required red, absent, green → kept; green also takes NEUTRAL and SKIPPED, which satisfy a required check (rb:54-55). Each red check carries its run id.
- sum:20-21 · Threads, unresolved → kept, plus one line per unresolved thread: id, file and line, author, answered or UNANSWERED, a gist.
- sum:22 · Header: number, merge state, head SHA, commit time → kept, plus `mergeable`, base, and head branch.
- sum:23 · Reviews line with requested reviewers (user, team, or name) → kept; a team the token can't read prints as such instead of blank.
- sum:24 · Required count over 8 → kept, over the real count, with where the list came from.
- sum:25 · Other failing checks and the running count → kept.
- sum:26 · Thread totals and `resolvedBy` → kept, plus the outdated count.

### q.graphql (scratch)

- q:2 · Hard-coded owner and repo → dropped: variables filled from `--repo`, the state file, or `gh repo view` (ruling 1).
- q:3-22 · One alias per PR, hard-coded → sum.js generates the aliases each sweep; q.graphql is the fragment only.
- q:26-27 · number, title, state, isDraft, mergeable, mergeStateStatus, base and head refs, createdAt, updatedAt → kept, plus mergedAt and author. createdAt and updatedAt are dropped: nothing reads them.
- q:28-34 · Last commit's oid, time, and rollup (last 100 contexts, CheckRun and StatusContext shapes, with their URLs) → kept, URLs included (sum.js reads the run id from them).
- q:35 · Last 30 reviews with author, state, time → kept.
- q:36 · Last 10 review requests, user or team → kept, plus bots and mannequins.
- q:37 · Last 50 threads: id, resolved, outdated, resolvedBy, path, line, first 3 comments with author, body, time → kept with the first 10 comments, so "answered" sees the author's reply; the comment time is dropped: nothing reads it.

### tick.js (scratch)

- tick:1 · Reads `state.json` from the working dir → kept; the path is an argument.
- tick:2 · Stamps `updatedAt` and counts the tick → kept; the count only with `--tick`.
- tick:3 · A tick label written into the note → not carried: the note is whatever the patch says.
- tick:4-8 · One hand-written lane (a real PR, its branch, a worktree path, a long note) → generalized to a patch file that merges any lanes, drops lanes, and replaces stages whole. The real PR, branch, and path are dropped (Global Constraints).
- tick:9 · Activity entry `{ t, text }` → `{ at, text }`, the field the old renderer and Orbit's parser both read.
- tick:10 · Keep the last 12 activity entries → kept.
- tick:11 · Write the file → kept, through a temp file and a rename, so Orbit never reads half of it.

## pr-fixer (ruling 2)

The source dispatched unnamed fixers; `agents/pr-fixer.md` is the agent behind them. Its rules, and where they come
from:

- Front matter: `name: pr-fixer`; a description saying it makes one bounded fix for the monitor and exits; tools Read, Edit, Write, Bash, Grep, Glob, Skill (edit and push, run gates, invoke `orbit-starter:address-pr-comments`); no Agent and no Orbit tools, since it reports to the monitor and asks nobody; `model: inherit`, because the monitor picks the tier on each dispatch (mp:100).
- One bounded fix and exit; never poll CI; "fix, verify, push, report, exit" (mp:10-12, mp:92-93) → pr-fixer.md intro.
- The brief's exact files, lines, and error text are the starting point (mp:87) → § Read first.
- Read and mirror the precedent (mp:88-90) → § Read first.
- Don't chase the known noise the brief flags (mp:91) → § Read first.
- Gates from the profile, skip what's absent; the runbook when named (the lane rule, as in builder.md) → § Read first and § Gates.
- A hypothesis is a hypothesis; follow the evidence and say so; overturning it is good (mp:96-98) → § Read first.
- Work in the named worktree; a dirty tree means stop and report, never stash (mp:95) → § The worktree.
- Edit only the files the brief gives; anything else, stop and report (the lane's claimed-files rule; the monitor holds no `claim_files`, so it decides) → § Claimed files.
- Conflicts: merge or rebase as the repo does, mechanical ones resolved, semantic ones aborted and reported (mp:202, the source shepherd's conflict rules the monitor relied on) → § The fix.
- Stack conflict bursts with `git patch-id`; never blanket `-X ours` (rb:252-258) → § The fix.
- A CI-only failure reproduced against the merge commit, whole suite (rb:384-392) → § The fix.
- A failing test isn't a pr-fixer job; report it for `orbit-starter:test-healer` (the brief's routing) → § The fix.
- Cross-PR spec fixes: reuse green locators, fix specs not app, never skip or loosen (rb:308-309) → § The fix.
- Threads through `orbit-starter:address-pr-comments`; settled replies posted after the fix is pushed, open ones drafted and returned (mp:104's "replying to a settled nit", and the source shepherd's unattended override) → § The fix.
- Never resolve a thread (mp:112-113, mp:199-200) → § The fix and § Never.
- Run the profile's gates with the worktree's tools; trust CI over a named local false positive (the lane's gates rule) → § Gates.
- No green without pasted counts (mp:94) → § Gates.
- Two honest attempts, then stop; a failure back the same way after a fix is the monitor's call (the lane rule; mp:202-203) → § Gates.
- Never force-push, hard-reset, or `-X ours/theirs` (mp:196) → § Never.
- Never commit to the base branch (mp:197) → § Never.
- Never fix someone else's breakage on the base from this PR (mp:201) → § Never.
- Never guess on semantic conflicts, ambiguous comments, or repeat failures (mp:202-203) → § Never.
- No story ids in source (rb:297-298) → § Never.
- Never weaken an assertion or delete a test (the lane rule) → § Never.
- Report: outcome first, changes with file and line, the pushed SHA, pasted gate output, replies posted and drafted, what wasn't verified, files needed (mp:94, mp:190-191) → § Report back.

## What the port adds

Not in the sources; each follows from Orbit's contract, the profile, or a ruling.

- The profile's `merge` and `resolveThreads` (`ask` by default, `auto`, `never`) and the batched needs_you: one ask for every ready PR, a button per PR plus "Merge all" and "Not yet", four PR buttons when more than four are ready (Review Focus 3) → skill Phase 5.
- Orbit keeps one open ask per lane and any message, a tick included, clears it, so the monitor rebuilds and re-raises the ask each tick, asks about threads before the merge, and withdraws it when nothing waits → skill § The batched ask.
- A merge the user approved re-checks the gates first, since the answer can come ticks later → skill § The batched ask.
- `merge-async` needs the user's yes even with `merge: auto` (rb:239-241 applied to the new knob) → skill § Stacks.
- The merge method comes from the runbook, or the one the repo allows → skill § The gates; template § Merge gates.
- A failing test goes to `orbit-starter:test-healer`, with the no-loop, real-counts, and dirty-tree rules written into its brief, and its unposted quarantine follow-up raised to the user → skill Phase 3 and Phase 4.
- A fixer's worktree is the branch's existing one or a new one bootstrapped by `orbit-starter:worktree-bootstrap` → skill Phase 4.
- The tick's wording is a pointer, not the state; a tick naming another repo is swept with `--repo` → skill § How Orbit runs you and Phase 1.
- Product questions go to `ask_product_owner` after `list_product_questions` (the kickoff) → skill § How Orbit runs you.
- Outside Orbit, one sweep and stop, since nothing sends ticks → skill § How Orbit runs you.
- A missing profile key is skipped, never an error (Review Focus 1) → skill § The repo profile and the runbook.
- `story` is read through the profile's `prLink`; the monitor never moves stories, the PM does → skill Phase 6 and § Guardrails.
- The example runbook gains a short § PR monitor (merge method, default reviewer teams, the ruleset's gates), so the facts the skill reads exist in the example → `examples/nx-web-api/.claude/orbit/runbook.md`.
