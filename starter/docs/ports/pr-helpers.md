# Port checklist: the PR helper skills

What each rule of the five sources became in the starter. One line per rule.

- `ps:N` is line N of the source pr-shepherd SKILL.md. `cif:N` is its references/ci-failures.md, `con:N` its
  references/conflicts.md. `cw:N` is the source ci-watch SKILL.md. `apc:N` is the source address-pr-comments
  SKILL.md. All live in the source user's own config, outside this repo.
- Destinations: `shepherd` is `skills/pr-shepherd/SKILL.md`, `shepherd-ci` and `shepherd-conflicts` are its two
  references, `ci-watch` is `skills/ci-watch/SKILL.md`, `apc` is `skills/address-pr-comments/SKILL.md`. "Profile" is
  the repo profile (`docs/repo-profile.md`). `runbook` is the file the profile's `runbook` key names.
- Controller rulings for this task: a failing test goes to `orbit-starter:test-healer`; merging and thread resolving
  follow the profile's `merge` and `resolveThreads` (default `ask`); `nx` commands become `gates`; required checks,
  known flakes, and the reviewer team come from the runbook; people become "the user".

## pr-shepherd SKILL.md

- ps:3 · Description: shepherds one PR, loop over CI, reviews, conflicts, phrases that trigger it → `shepherd` description.
- ps:3 · "Also runs as an auto-launched background agent whenever Claude opens a new PR" → dropped: stale. The hook that launched it was removed, and `shepherd` says it never starts on its own.
- ps:4 · user-invocable → kept.
- ps:7 · Long-running loop over CI, reviews, conflicts → `shepherd` intro.
- ps:9-14 · Orchestrates ci-watch and address-pr-comments; escalation rules win over the approval gate → `shepherd` intro, as `orbit-starter:` references.
- ps:16-25 · Autonomous list: lint and format, mechanical test and build, settled comments, trivial conflicts → `shepherd` § Autonomy posture.
- ps:27-32 · Escalate list: business logic or unclear cause, ambiguous comments, semantic conflicts, spent retry budget → same section.
- ps:34 · Escalation is a pause, not abandonment; always a status report → same section, closing paragraph.
- ps:36-41 · Unattended: stop and return the report as the final message, never block → `shepherd` § How to escalate (third bullet). Now also: Orbit `needs_you` when available, inline ask otherwise.
- ps:41 · Interactive may ask inline → § How to escalate (second bullet).
- ps:45-58 · Phase 0: resolve PR, number or URL wins, current-branch fallback, stop if not open, draft handling → `shepherd` § Phase 0.
- ps:58 · "The auto-trigger only launches on non-draft PRs" → dropped with the auto-launch claim; the draft rule itself is kept.
- ps:60-67 · Header printout → `shepherd` § Phase 0, plain text.
- ps:73-77 · Re-fetch state at the top of every tick → § Phase 1.
- ps:79-95 · Tick decision order, closed, conflicts, CI failing, CI running, new feedback, all green, quiescent → § Tick decision order, same order and reasoning.
- ps:93 · Do not merge unless the user asked → `shepherd` § Phase 5: follows the profile's `merge` (`never` stops, `ask` raises one needs_you, `auto` merges).
- ps:87 · Known-flaky retry candidates excluded from "failing" → tick item 3, now keyed to the runbook's known flakes.
- Added: a failing check that is not required and is runbook noise gets a note, not a fix (brief: required checks come from the runbook). `mergeable` reading `UNKNOWN` waits a tick (recon: `mergeable` lags).
- ps:99-101 · Poll 60s, 15s after a push, `--poll`, `--max-loops` default 120, heartbeat → § Pacing and budgets.
- ps:105-120 · Phase 2: conflicts first, merge the base, classify, abort on semantic, validate, never force-push → `shepherd` § Phase 2, plus `shepherd-conflicts`.
- ps:112 · "this repo merges, doesn't rebase" → "match how the base branch's history looks, default to merge".
- ps:117 · Re-run lint and test locally before push → § Phase 2 step 3, as `gates.lint` and `gates.test`.
- ps:126-136 · Phase 3 table: format, lint, unit, E2E, build, dependency, unknown → `shepherd` § Phase 3, same rows.
- ps:132 · Unit test dispatches `debugger` → `orbit-starter:test-healer` per ruling. `orbit-starter:debugger` stays as the fallback when the cause is unclear (`shepherd-ci`).
- ps:133 · E2E dispatches `test-healer` → `orbit-starter:test-healer`.
- ps:138 · Verify locally before pushing → § Phase 3 and `shepherd-ci` § Always verify.
- ps:140 · Known-flaky E2E (auth redirect, shard timing), rerun once → § Phase 3 flaky paragraph; the specific flake names move to the runbook.
- ps:146-154 · Phase 4: reviews via address-pr-comments, approval gate replaced by the autonomy posture, settled replies post, ambiguous ones escalate → `shepherd` § Phase 4.
- ps:150 · Never auto-resolve threads → `shepherd` § Phase 4 and `apc`: follows `resolveThreads` (`never` / `ask` / `auto`).
- ps:154 · Interactive may run the full approval flow instead → § Phase 4 last paragraph.
- ps:158-175 · Phase 5 outcomes: merge-ready, merged, escalated, backstop → `shepherd` § Phase 5.
- ps:168 · "I don't auto-merge" → replaced by the `merge` mode handling.
- ps:177-198 · Escalation report shape; final message when unattended, no polling after → § Escalation report.
- ps:185 · Example names a work-order data-access project → generic cart example.
- ps:202-209 · Guardrails: no force-push, no reset --hard, no merge outside permission, no unverified fix claims, stay in scope, one commit per batch, Co-Authored-By → `shepherd` § Guardrails. The trailer becomes "the trailer your setup uses".
- ps:209 · Retry-budget pointer → § Guardrails last bullet.
- Dropped by name: `scripts/on-pr-created.js` (not shipped; the auto-launch is gone) and emoji in the headers and report.

## pr-shepherd references/ci-failures.md

- cif:3 · Reuses ci-watch classification, goes further on mechanical fixes → `shepherd-ci` intro.
- cif:5 · Restore-intent vs change-behavior dividing question → same.
- cif:7-12 · How to get failure details with `gh run view` → `shepherd-ci` § Getting the failure details.
- cif:14-22 · Flaky gate, rerun once, same-way-twice is real, no repeated reruns → `shepherd-ci` § Flaky-test gate. Named flakes move to the runbook. Added: rerun is refused while any job runs (recon runbook:121-131).
- cif:26-33 · Format: write and push; pinned prettier v2; CRLF false positive, trust CI, end-of-line auto → `shepherd-ci` § Format, generic, with the repo specifics in the runbook's Gate quirks.
- cif:35-42 · Lint: fix, hand-fix, verify with `nx affected`, push → § Lint with `gates.lint`.
- cif:44-56 · Unit test: reproduce, debugger brief, escalate if not mechanical → § Tests, now test-healer with its brief; reproduce with `gates.test`.
- cif:58-64 · E2E: component-library selectors, the shared mock setup, test-healer brief → § Tests, merged with unit; the library and mock names become generic causes.
- cif:66-70 · Build and type: clear errors fixed, design changes escalated; `nx build` → § Build and type errors; no build gate in the profile, so "run what CI ran".
- cif:70 · Nx `dependency-checks` peerDeps quirk → § Build and type errors, generic; the exact rule stays in the example runbook (API rules).
- cif:72-74 · Dependency failures escalate → § Dependency and install failures.
- cif:76-78 · Unknown: print last ~50 lines, stop → § Unknown.
- cif:80-82 · Verify before pushing → § Always verify before pushing.
- cif:84-91 · Retry budget: two fix cycles, third escalates, tighter than ci-watch's three → § Retry budgets.

## pr-shepherd references/conflicts.md

- con:3 · Resolve only what is honest and mechanical; never wipe the other side → `shepherd-conflicts` intro.
- con:5-14 · Step 1: fetch and merge the base; stale CONFLICTING → Step 1; "this repo merges" becomes "match the base's history, default merge". Adds the profile's `baseBranch`.
- con:16-22 · Step 2: list conflicted files, read each fully → Step 2.
- con:26-39 · Trivial: lockfiles regenerated, union imports, regenerate generated files, stack changelogs, whitespace → Step 3 Trivial. `npm install` becomes "the repo's install command" (profile `worktree.install` when set).
- con:41-48 · Semantic: same body, business logic, upstream or DTO mapping, unprovable side, low context → Step 3 Semantic, with "contract or DTO mapping".
- con:50-56 · Abort the merge, report files and hunks with a one-line description each → Step 3, plus an Orbit needs_you when available.
- Added: base-rewrote-commits conflicts are often the same change twice (recon: patch-id dedup lesson). Push can dismiss an approval, so tell the user (recon runbook:59-84).
- con:58-67 · Step 4: validate with `nx affected -t lint,test`; failure means a logical conflict, escalate → Step 4 with `gates.lint` and `gates.test`.
- con:69-76 · Step 5: `git commit --no-edit`, push, CI picks it up → Step 5.
- con:78-82 · Hard rules: no force, no reset --hard, no blanket `-X ours/theirs`, abort when in doubt → § Hard rules.

## ci-watch SKILL.md

- cw:2-4 · Name, description, user-invocable → kept; description says it hands tests to `orbit-starter:test-healer` instead of "debugger/healer".
- cw:7-11 · Watch a run, auto-fix lint and format, report tests → intro.
- cw:13-18 · Input forms: none, run id, `--branch`, `--pr` → kept.
- cw:20-24 · Platform rules: pipelines are GitHub Actions, use `gh` → kept except the branch-prefix rule (also in the source list), dropped: a person fact. Never-ADO wording dropped for the same reason. Added: read the profile and runbook.
- cw:28-37 · Phase 1 resolve the run, stop if none → Phase 1a. Added: several workflows per PR, ask which.
- cw:39-46 · Initial status printout → Phase 1b.
- cw:50-64 · Poll every 30s, update every 2 minutes, 30-minute timeout ask → Phase 2.
- cw:68-76 · Success prints the passed line and stops → Phase 3a.
- cw:78-92 · Failure: fetch failed jobs, steps, and log → Phase 3b. Added: check runbook known flakes and rerun once first.
- cw:98-115 · Category A format: write, commit "style: fix formatting to pass CI", push, watch → Category A, `npm run prettier:write` becomes the formatter in write mode on `gates.format`'s tool.
- cw:119-140 · Category B lint: parse, `nx lint --fix`, hand-fix, verify with `nx affected`, commit, push → Category B with `gates.lint`.
- cw:144-183 · Category C unit: parse, reproduce, diagnose four causes, report; suggests `/e2e-debug` → Category C, suggests test-healer. `/e2e-debug` dropped: not shipped.
- cw:187-221 · Category D E2E: parse, read spec, four causes (component library, mock setup, timing, regression), suggest test-healer → Category D with component library and mock setup stated generically.
- cw:225-253 · Category E build: parse error code and line, diagnose, offer to fix → Category E.
- cw:257-272 · Category F dependency, report only → Category F.
- cw:276-292 · Category G unknown, raw 50 lines → Category G.
- cw:296-314 · Post-fix monitoring: wait, find the new run, manual re-trigger hint, max 3 cycles → Phase 5.
- cw:318-339 · Final report template → Phase 6.

## address-pr-comments SKILL.md

- apc:2-4 · Name, description, user-invocable → kept; "resolve" dropped from the description's triggers, since threads follow `resolveThreads`.
- apc:7-11 · Fix or justify each comment, drafts approved, then posted → intro.
- apc:13 · PR number or URL required; ask if missing → Input.
- apc:17 · User-specified PR only → Hard rule 1.
- apc:18 · Only unresolved threads → Hard rule 2.
- apc:19 · All three comment types → Hard rule 3.
- apc:20 · One squash commit → Hard rule 4 ("one commit").
- apc:21 · No auto-resolving threads → Hard rule 5: follows `resolveThreads`. Reviewer-decides is `never`, an offer in the batch is `ask`, resolve after reply and push is `auto`. Phase 4 adds the question and Phase 5 the GraphQL mutation.
- apc:22 · Approval before posting → Hard rule 6, with a note that pr-shepherd and pr-fixer instructions replace the gate when unattended.
- apc:23 · Natural teammate tone → Hard rule 7.
- apc:29-38 · Validate `gh`, dirty tree warning → Phase 1a.
- apc:42-54 · Resolve the PR, check it out, note the base → Phase 1b.
- apc:58-69 · Fetch the three comment kinds, GitHub MCP preferred → Phase 1c.
- apc:71-76 · Filters: self-notes, outdated, empty reviews, resolved threads → Phase 1c.
- apc:76-89 · GraphQL `reviewThreads` query → Phase 1c.
- apc:91 · Working list fields → Phase 1c, with `thread_id` also used to resolve.
- apc:95-101 · Read surrounding code and the PR diff → Phase 1d.
- apc:107-127 · Fix, justify, ambiguous; batch ambiguous questions; wait → Phase 2.
- apc:129-141 · Push-toward-justify and push-toward-fix lists → Phase 2.
- apc:147-151 · Apply fixes tightly scoped, track source, no commit yet → Phase 3.
- apc:153-160 · Run gates, don't bypass, stop on failure → Phase 3, `nx affected -t lint,test` becomes `gates.lint`, `gates.test`, and `gates.format` when set.
- apc:162-180 · One commit, push, skip an empty commit; Co-Authored-By line → Phase 3, the trailer becomes "the trailer your setup uses".
- apc:188-211 · Reply tone rules and good and bad examples → Phase 4. The example `InboundDel` reference becomes `deliveryId`.
- apc:215-244 · Batch presentation → Phase 4. File and line shown as "line N", not a `x:y` token.
- apc:248-257 · Edit, remove, or post-all prompt; loop until approved → Phase 4.
- apc:263-292 · Post inline in-thread with `in_reply_to`, review-body and conversation replies as an @-mention → Phase 5.
- apc:294 · Post sequentially, don't halt on one failure, list failures → Phase 5.
- apc:296 · Do not resolve threads → Phase 5 § Resolving threads, per `resolveThreads`.
- apc:300-311 · Confirm summary → Phase 6, plus a Resolved count.
- apc:315-320 · Notes on judgment → kept in full; the last one points at `resolveThreads`.

## Shared files

- `examples/nx-web-api/.claude/orbit/runbook.md`: appended a "CI failure lessons" section with five sample lessons
  (sign-in redirect flake, rerun refusal, peerDeps lint, selector drift, semantic conflict in a mapper).
