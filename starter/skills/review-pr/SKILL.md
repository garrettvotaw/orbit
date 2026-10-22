---
name: review-pr
description: Review a teammate's GitHub PR and post inline comments. Fetches the diff, reviews with senior-developer judgment, verifies the optional flag-and-scope check before any approve, previews the comments, then posts to GitHub in a natural tone. Orbit starts a review lane with /orbit-starter:review-pr and a PR number.
user-invocable: true
---

Review a teammate's GitHub PR, present comments for approval, then post inline review comments to GitHub.

## Instructions

You are reviewing a teammate's pull request. Your job is to find issues worth commenting on, present them for approval, then post them to GitHub as inline review comments — all in a natural, senior-developer tone.

**Input**: $ARGUMENTS — a PR number (e.g., `1234`). Optional flag: `--approve` to auto-approve after posting. It still stops at the flag gate in 4a.

If no PR number is provided, ask the user for one and stop.

**HARD RULES — READ THESE FIRST**:

1. **Read-only on code.** You MUST NOT check out the PR branch, edit any files, create commits, run tests, or run linters. You only read, self-assign the PR, and post comments. (Self-assigning is a GitHub metadata action, not a code change — it's allowed and required, see Phase 1.)
2. **No other skills.** Do not invoke or reference any other skill, and do not hand the review to a fixer. The deep multi-agent version is a separate skill, `orbit-starter:pr-review-swarm`, and the user picks it, not you.
3. **Natural tone.** Every comment must sound like a helpful senior developer wrote it. See Tone Rules below.
4. **GitHub only.** Use `gh` CLI for all GitHub operations.

---

## Phase 1: GATHER CONTEXT (silent — no output to the user)

### 1a. Self-assign the PR (do this FIRST, before anything else)

Before validating auth, fetching metadata, or reading a single line of the diff, claim the review by assigning yourself to the PR. This signals to the team that the PR is being reviewed and prevents two people from picking it up at once.

```bash
gh pr edit <number> --add-assignee @me
```

If the command fails (e.g. auth not set up yet, or the PR number is invalid), don't stop the review over it — note it silently and continue; the next step (auth validation) will surface a real auth problem with a clear message. A failed self-assign is not fatal to the review itself.

### 1b. Validate gh CLI

Run: `gh auth status`

If it fails:

```
FAILED: gh CLI is not authenticated.
Fix: Run `gh auth login` in your terminal
```

Stop here.

### 1c. Fetch PR metadata

Run:

```bash
gh pr view <number> --json title,body,author,baseRefName,headRefName,changedFiles,number,url
```

Extract: title, body (description), author login, base branch, head branch, list of changed files, PR URL.

### 1d. Fetch the diff and commit messages

```bash
gh pr diff <number>
gh pr view <number> --json commits -q '.commits[] | .messageHeadline'
```

Commit messages often reveal intent that the PR description leaves out.

### 1e. Read full file contents

Read the full content of every changed file, not just the diff hunks. You need the surrounding context to judge whether a change is correct — a diff line looks fine in isolation and wrong once you see the function it lives in.

### 1f. Check for project-specific conventions (optional)

Look for a team review/convention doc in the repo, in this order:

1. `.github/prompts/code-review.prompt.md`
2. `.github/CODE_REVIEW.md`
3. `CONTRIBUTING.md`
4. `docs/code-review.md`
5. The runbook the repo profile names under `runbook` (`.claude/orbit/repo.json`), when it has one

If one exists, read it for **project-specific conventions you wouldn't know otherwise** — naming rules, library/folder structure, test patterns, architectural boundaries, team style preferences. Treat it as _reference material about this repo_, not as the definition of what to review.

If nothing exists, skip this step. A review without a convention doc is still a real review.

### 1g. Pull the Flag and Scope Check (optional)

This step, 2d, and the flag gate in 4a are an optional workflow. Some repos run a `pr-flag-and-scope-check` agentic workflow that comments a `## 🚩 Flag and Scope Check` table on the PR. If `.github/workflows/pr-flag-and-scope-check.md` doesn't exist on the base branch, skip this step, 2d, and the flag gate in 4a.

Otherwise find the newest comment carrying the workflow's marker:

```bash
gh api repos/{owner}/{repo}/issues/<number>/comments --paginate --slurp \
  | jq '[.[][] | select(.body | contains("gh-aw-workflow-call-id: {owner}/{repo}/pr-flag-and-scope-check"))] | last
        | {body, run_id: (.body | capture("id: (?<r>[0-9]+), workflow_id").r)}'
```

The workflow only runs on opened, reopened, and ready_for_review, so pushes after that aren't covered. Compare the SHA the run checked to the PR head:

```bash
gh run view <run_id> --json headSha -q .headSha
gh pr view <number> --json headRefOid -q .headRefOid
```

That gives the check one of three states:

- **current**: the SHAs match.
- **stale**: the head moved since the run.
- **missing**: no comment. Run `gh run list --workflow pr-flag-and-scope-check.lock.yml --branch <headRefName> --json status,conclusion,headSha` to see whether it's still running, failed, or never ran (drafts and authors without write access are skipped).

---

## Phase 2: REVIEW

### 2a. Understand the change before critiquing it

Before hunting for issues, build a mental model of the PR:

- **What is this PR trying to do?** Read the title, description, and commit messages. What's the user-visible behavior change, the bug being fixed, or the refactor being attempted?
- **What's the risk surface?** Wrong numbers in a report? Corrupted data? A security hole? A subtle race? A performance regression in a hot path? Every PR has one or two things that would actually hurt if done wrong — name them.
- **Where should scrutiny concentrate?** The riskiest code isn't always where the diff is largest. A 3-line change to a SQL query, an auth check, or a state reducer deserves more attention than 200 lines of generated types or test boilerplate.

You're not running through a checklist — you're asking "would I sign off on this as the author's most experienced teammate?"

### 2b. Review the code

Read each changed file against its surrounding context. Use your full engineering judgment. The categories below are **prompts for your attention, not an exhaustive list** — they're meant to warm up the kinds of thinking that catch real bugs. If something smells wrong for any reason you can articulate, it's worth a finding, whether or not it fits a category here.

- **Correctness.** Off-by-ones, wrong operators, null/undefined handling, forgotten branches, race conditions, state that gets out of sync, logic that doesn't match what the PR claims to do, edge cases the author didn't consider.
- **Security.** Injection (SQL, command, XSS, path traversal), missing authz checks, sensitive data logged or returned to clients, unsafe deserialization, trust boundaries violated, secrets in code, missing input validation at system edges.
- **Concurrency & resources.** Leaked subscriptions/handles/connections, unbounded loops, N+1 queries, hot-path work that runs every render, memory retention, missing cleanup on error paths.
- **API & contract changes.** Breaking changes to exports, types, DTOs, routes, or events that callers don't know about. Silent behavioral changes to shared utilities. Schema/migration changes that won't roll back cleanly.
- **Maintenance hazards.** Copy-paste that will drift, dead code, comments that lie about what the code does, names that mislead, abstractions that add weight without carrying it, overly clever code where straightforward would do.
- **Tests where they matter.** If the change touches risky territory (money, auth, migrations, concurrency, data integrity), is there a test that would have caught a regression? Missing trivial tests usually aren't worth a comment; missing tests around risky code are.
- **Was there a simpler path?** See 2c — the "is this the right approach at all" question is the one reviews miss most often, so it gets its own step.

If a project convention doc from Phase 1f is relevant to a finding, lean on it — but don't manufacture findings just because a checklist item exists. The convention doc is a floor for local style, not a ceiling on your judgment.

### 2c. Was there a simpler path?

Correct is the floor, not the bar. Once you've satisfied yourself that the code works, ask the separate question the author was too deep in it to ask: **is this the simplest way to get this behavior, and did the PR leave the codebase easier or harder to work in?**

Concretely, for the main mechanism the PR introduces:

- Does something in the repo already do this? A helper, mapper, selector, guard, or util that got reimplemented because the author didn't know it existed.
- Could this have been fewer moving parts? A new file, layer, abstraction, config flag, or indirection that a direct call or an existing extension point would have covered.
- Is complexity landing in the right place? Logic the API layer should own leaking into the client, or a derivation the client re-does that the response already carries.
- Would a small change elsewhere have made this change unnecessary? Fixing the upstream shape, moving one file, or correcting one type is often smaller than the code written to accommodate it.
- Read the diff's size against what it accomplishes. A big diff for a small behavior change is a signal — say what you'd have expected instead.

When the answer is "yes, there was a simpler path," describe it in one or two sentences with the concrete alternative. If it's too late or too risky to change now, say that too, but don't stay silent because the current approach functions. Silence reads as endorsement, and the next PR builds on it.

Judgment call, not a mandate: don't demand a rewrite over taste, and don't invent a hypothetically-cleaner design you can't point at in the repo. Raise it when the simpler path is real, nameable, and meaningfully less code or fewer concepts.

#### The most common case: a workaround that should have been a fix

A clean-looking workaround is still a workaround. Before you accept any of these, stop and cost out the direct fix:

- An `eslint-disable`, `@ts-ignore`, `as unknown as`, or cast that exists only to get past a rule
- A value/type duplicated in a second place with a "keep these in sync" comment, or a compile-time guard whose whole job is to police that duplication
- Anything in the diff or PR body described as "blocked by", "couldn't import", "would be a circular dep", "to keep X leaf-like", "temporary", "for now", or "design deviation"
- A helper added to work around where a file currently lives, rather than moving the file
- A new abstraction whose only justification is an existing structural problem

For each one, answer explicitly: **what would it take to delete the restriction?** Very often it's a file in the wrong library, a type that belongs in the domain lib instead of a general/shared/common bucket, or a dependency pointing the wrong way. Moving a type into its actual home is usually a mechanical, low-risk change — and it makes the workaround, the sync comment, and the guard all vanish.

If the direct fix is comparable in effort, say so and name it concretely: which file moves where, and what that deletes. If the direct fix is genuinely large or risky, that's a legitimate answer — but the workaround then needs a tracked follow-up, not just a code comment.

Two failure modes to avoid:

1. **Accepting the author's framing.** When a PR body explains why a workaround was necessary, that explanation is the thing under review, not context that settles it. If the author already named the real fix ("the natural fix is to move X into Y"), that IS the finding — you're agreeing with them, so say it out loud instead of approving around it. Don't let a well-written rationale substitute for verifying the constraint is real.
2. **Reviewing the workaround's correctness and stopping there.** Confirming a guard works, or that a cast is safe, is not the same as confirming the guard should exist. Layering tech debt on tech debt reads as diligence in a diff and compounds in the codebase.

Weight it like any other finding: `major` when the workaround will spread or is load-bearing for future PRs, `suggestion` when it's contained. But don't drop it just because the workaround functions.

### 2d. Verify the Flag and Scope Check

Skip if 1g found no workflow. Otherwise treat the check's table as leads to verify. The bot misses ungated shared code and also flags gates that are really there, so verify against the code before trusting it either way. Use the rubric in `.github/workflows/pr-flag-and-scope-check.md` on the base branch for how gates are traced and how rows are rated. Don't make up your own.

What to trace depends on the 1g state:

- **current**: verify every 🔴, 🟠, and 🙋 row and every 🆕 flag name. Also spot-check any 🟢 row that touches a shared lib, service, store, mapper, or DTO, since collateral reach is what the bot misses most.
- **stale**: do the same, plus trace every change since the run's SHA yourself. Limit it to files that are also in the PR's changed-file list, because a main merge shows up in that range too.
- **missing**: trace the whole PR yourself with the rubric.

You can read PR-head code without checking anything out. `git fetch origin pull/<number>/head`, then `git show <headRefOid>:<path>` for a file and `git grep -n <pattern> <headRefOid> --` for callers. Fetching doesn't break the read-only rule.

Every row that holds up becomes a finding on the changed line it describes:

- 🔴 live with no flag: `major`. Name who gets the new behavior, then ask the author to gate it or confirm it's meant to ship ungated. A fix is still live.
- 🟠 unknown gate: `major` if it reaches end users, otherwise `minor`. Say where the trace stopped.
- Unrequested scope: `major` if it's ungated, `suggestion` if it's behind a flag. Quote what the PR did ask for.
- 🆕 flag name: `minor`. It has to be created in the feature-flag service before the feature does anything, because a missing flag resolves to its fallback.

Keep a list of the rows you overturned, each with the file and line that settles it. Those go in the Phase 3 flag gate block and never become comments.

### 2e. Collect findings

Each finding has:

- **File path** — relative to repo root
- **Line number** — the absolute line number in the file (as required by the GitHub API), NOT the diff hunk offset
- **Severity** — one of: `critical`, `major`, `minor`, `suggestion`
- **Comment body** — written per the Tone Rules below

### Tone Rules

These are non-negotiable. Every comment MUST follow these rules:

- **No AI filler.** Never write: "Consider leveraging...", "It would be prudent to...", "It's worth noting that...", "Great job on...", "Nice work!", "LGTM overall but..."
- **Direct and specific.** Say what the issue is and why it matters. Don't hedge.
- **Show code.** If suggesting a change, include a code snippet showing the fix.
- **Brief.** One issue per comment. No essays. 2-4 sentences max unless a code block is needed.
- **Helpful teammate voice.** Write like a senior dev who wants the author to succeed — not like a tool generating a report.

Example of a GOOD comment:

> This query fetches all invoices but only uses the first one. If several invoices share the same order id, the rest get silently dropped. Filter by `invoiceId` here to get the one you need.

Example of a BAD comment:

> Consider leveraging the `invoiceId` field to filter invoices more precisely. It would be prudent to ensure that multiple invoices are handled correctly to avoid potential data loss scenarios.

### Filtering

Only surface findings that are genuinely worth a human comment. **Skip**:

- Formatting issues (Prettier handles this)
- Lint violations (ESLint handles this)
- Trivial naming preferences
- Things that are technically valid but you'd phrase differently
- Style nitpicks where the PR matches surrounding code

The goal is **signal over volume**. 3 meaningful comments beat 15 nitpicks.

A 2c finding is never a nitpick, though — "there was a simpler path" or "this works around something we should just fix" outranks most correctness nits, because it's the one thing the author can't see from inside the change. Don't filter it out for being architectural rather than a bug.

2d findings never get filtered out either.

### No findings?

If the code looks solid and you have no meaningful comments, say so. Print the flag gate block from Phase 3 first. A PR with an open flag gate row has findings, so it doesn't land here.

```
PR #1234 looks clean — no issues found. Approve, request changes, or leave as-is? (a/r/leave)
```

Skip Phase 3 and go directly to Phase 4 (status only, no comments to post).

**Under Orbit** (the `ORBIT_LANE` environment variable is set), call
`mcp__orbit__review_preview` with an empty `findings` list instead of asking, then end your
turn. The user picks the status in Orbit and Orbit posts it itself. You hear back only if Orbit
couldn't post it, and then the reply names the status for you to post in Phase 4.

---

## Phase 3: LOCAL PREVIEW

Present ALL proposed comments in a numbered list:

```
## PR #<number> Review — <count> comments

1. [major] path/to/file.ts:42
   This query fetches all invoices but only uses the first one. If several
   invoices share the same order id, the rest get silently dropped.

2. [minor] path/to/other-file.ts:18
   This listener is never removed. It will leak if the
   component gets destroyed mid-flight.

3. [suggestion] path/to/service.ts:95
   This could use the existing mapInvoiceResponse() helper instead of
   manually mapping fields. Keeps the transform logic in one place.
```

If 1g found the workflow, follow the list with the flag gate block. Open rows point at their comment number. Write `Flag gate: clear` when there's nothing open or overturned.

```
### 🚩 Flag gate (check current at abc1234 | stale since abc1234, N files traced by me | missing, traced by me)

- 🔴 Hide deleted documents in the shared read: live for every getDocuments caller (comment 1)
- 🆕 `release-checkout-foo` has to exist in the feature-flag service (comment 3)
- Overturned: bot said the orders grid column is 🔴, but a route guard covers it (app.routes.ts, line 88)
```

Then prompt:

**Remove any comments by number (e.g. "2, 4"), or hit Enter to post all.**

**Under Orbit** (`ORBIT_LANE` is set), still show the numbered list, then call
`mcp__orbit__review_preview` with every finding (`n`, `severity`, `file`, `line`, the first
sentence as `gist`, and the whole comment exactly as it should land on GitHub as `body`) and end
your turn. The user drops comments and picks the status in Orbit, and Orbit posts the review
itself in one call, so don't post it and don't ask 4a. You hear back only when Orbit couldn't
post it: then one reply answers this prompt and 4a together, e.g. "Drop comment 2 and post the
rest. Approve.", and you post it per 4b.

Wait for the user's response:

- If they provide numbers: remove those comments from the list
- If they hit Enter (empty response): keep all comments
- If they ask to reword a comment: adjust it and re-present the updated list
- If they say "none" or remove all: skip to Phase 4 with no comments

---

## Phase 4: POST & STATUS

### 4a. Determine review status

If `--approve` was passed as an argument, use `APPROVE` as the event.

Otherwise, prompt:

**Approve, request changes, or leave as-is? (a/r/leave)**

Map the response:

- `a` → `APPROVE`
- `r` → `REQUEST_CHANGES`
- `leave` or Enter → `COMMENT`

**Flag gate.** When the event is `APPROVE` and the flag gate block has any open row (🔴, 🟠, unrequested scope, or a 🆕 flag name), list those rows again and ask:

**These ship as-is if you approve. Approve anyway? (yes/no)**

This applies whether or not the row's comment survived Phase 3, and `--approve` doesn't skip it. A `no` drops back to the a/r/leave prompt. If 2d couldn't finish, for example the PR head wouldn't fetch, the gate counts as open and the block says what wasn't traced.

Under Orbit, the open rows were already findings in `review_preview`, so the user's pick in Orbit (or Orbit's reply, when it hands the post back to you) is the confirmation. Don't ask again.

### 4b. Post the review

Post all surviving comments AND the review status in a **single API call**. This sends one notification to the PR author, not a flood.

Determine the repo owner and name:

```bash
gh repo view --json owner,name -q '.owner.login + "/" + .name'
```

Build the JSON payload and post:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/reviews \
  --method POST \
  --input - <<'EOF'
{
  "event": "<EVENT>",
  "comments": [
    {
      "path": "relative/path/to/file.ts",
      "line": 42,
      "body": "Comment text here"
    }
  ]
}
EOF
```

Where:

- `event` is `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`
- `comments` is the array of surviving comments from Phase 3
- `path` is relative to the repo root
- `line` is the absolute line number in the file
- `body` is the comment text

If there are no comments (user removed all, or no findings), omit the `comments` array and just post the event.

### 4c. Confirm

Print a one-line summary:

```
Done — <count> comments posted to PR #<number>, status: <status>
```

If no comments were posted:

```
Done — PR #<number> status: <status>
```
