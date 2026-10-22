---
name: pr-review-swarm
description: Deep multi-agent PR review. Sizes the diff by risk, dispatches specialist review agents in parallel scoped to what actually changed, verifies every candidate finding against real code to kill false positives, then ranks and previews the result before optionally posting inline comments to GitHub. Use when the user says "review this PR", "swarm review", "deep review", "review PR 1234", or wants a thorough pre-merge review of branch changes. Optional; the quick single-reviewer version is orbit-starter:review-pr.
user-invocable: true
---

Run a depth-first, multi-agent review of a pull request or branch diff.

Optional arguments: $ARGUMENTS — a PR number, a base ref, or flags like `--local` (never post) or `--agents a,b`.

## Principles

These are not optional. They are what separate a review people trust from one they mute.

1. **Never approve, never merge, never edit.** This skill produces findings. A human decides. Reviews are posted with `event: COMMENT` only.
2. **Precision over recall at the output.** Specialists are tuned for recall; the verifier is tuned for precision. Nothing reaches the author unverified.
3. **Never duplicate CI.** The repo's gates own formatting, lint, dependency rules, and type errors. They are the `gates` block of the repo profile (`.claude/orbit/repo.json`). A finding about formatting is stealing attention from a real bug.
4. **Evidence or silence.** Every finding cites a source file and line that demonstrates the behavior. Inference from naming is not evidence.
5. **Signal density is the product.** Forty nits equals zero nits.

## Step 1 — Resolve the target

If `$ARGUMENTS` contains a number, treat it as the PR number. Otherwise:

```bash
gh pr view --json number,title,headRefOid,baseRefName --jq '{number,title,headRefOid,baseRefName}'
```

If that fails there is no PR for the current branch. Fall back to a local diff against the profile's `baseBranch` (`main` when there is no profile) and force local-only output (no posting). Tell the user you did this.

Record the PR number, title, and `headRefOid` (needed to post).

## Step 1b — Claim the PR

Assign yourself before any agent is dispatched, so the PR shows an owner while the review is in flight:

```bash
gh pr edit <NUMBER> --add-assignee @me
```

This is idempotent; re-adding an existing assignee succeeds. It is bookkeeping, not a gate. If it fails (fork without write access, or the local-diff fallback where no PR exists), report it in one line and continue with the review.

## Step 2 — Size the diff by risk

Run the script that sits in this skill's `scripts/` directory:

```bash
node <this skill's directory>/scripts/risk-size.js --pr <NUMBER> --json
```

(or `--base <baseBranch>` for a local diff)

It reads the repo profile at `.claude/orbit/repo.json` and applies `review.riskGlobs` ahead of its generic defaults. A profile with no `review` block is fine. The script returns `rawTotal`, `weightedTotal`, `depth`, per-bucket file lists, `suggestedAgents`, and `sizeBands` (the profile's `review.sizeBands`, or null). Raw line count is a poor proxy for review effort. A 1,200-line PR that is mostly spec files is a small review. Use `weightedTotal`.

Show the user a one-line summary before dispatching, e.g.:

> PR #1852 — 621 raw lines, 675 weighted, depth `deep`. Dispatching 5 agents.

**Depth controls scope, not rigor:**

| Depth      | Weighted   | Behavior                                                                  |
| ---------- | ---------- | ------------------------------------------------------------------------- |
| `light`    | < 150      | Only agents whose buckets appear; skip `orbit-starter:review-bloat`       |
| `standard` | 150–600    | All suggested agents                                                      |
| `deep`     | > 600      | All suggested agents; split large buckets into per-area agents            |

On `deep` with more than ~40 files in one bucket, dispatch that agent **twice**, splitting the files by top-level area (app, package, or service) so neither instance has to hold the whole diff.

Honor `--agents` if the user passed it.

## Step 3 — Fetch the diff

```bash
gh pr diff <NUMBER> > <session-workspace>/pr-<NUMBER>.diff
```

Write it to the session workspace, not the repo. Agents read this file plus the working tree for surrounding context.

## Step 4 — Dispatch specialists in parallel

Launch every selected agent **in a single batch** with the Agent tool so they run concurrently. Agent types are the review agents this plugin ships:

| Agent                                  | Dispatch when these buckets are present                          |
| -------------------------------------- | ---------------------------------------------------------------- |
| `orbit-starter:review-contract`        | `contract`, `integration`                                        |
| `orbit-starter:review-auth-context`    | `auth`                                                           |
| `orbit-starter:review-reactivity`      | `client`, `state` (Angular example; skip it in other stacks)     |
| `orbit-starter:review-silent-failure`  | `server-logic`, `integration`, `auth`                            |
| `orbit-starter:review-test-quality`    | `test`                                                           |
| `orbit-starter:review-bloat`           | `client`, `server-logic`, `other`, when weighted is 150 or more  |

The bucket names come from `scripts/risk-size.js` and from the profile's `review.riskGlobs`. A repo with no Angular code never gets the reactivity agent, because no file lands in `client` or `state`.

Each agent is stateless. Give every dispatch:

- The absolute path to the diff file
- **Only the file paths in its buckets** — never the whole file list. Scoping is what keeps each context window tractable and stops agents commenting outside their expertise.
- The PR title and description for intent
- For `orbit-starter:review-bloat`, the `sizeBands` value from the script output (it may be null)
- The instruction to return **only** a JSON array per `references/finding-schema.md`

If an agent returns malformed JSON or nothing useful, do not retry more than once. Drop it and note the gap in the summary.

## Step 5 — Collect and assign IDs

Merge all arrays. Assign each finding a short stable `id` (`f1`, `f2`, …). Record the raw count, because you will report how many were filtered.

If the raw count is 0, report "no findings" and stop.

## Step 6 — Verify (do not skip)

Dispatch `orbit-starter:review-verifier` with the full candidate array. For more than ~25 candidates, split into batches of 20 and dispatch in parallel.

The verifier returns a verdict per candidate. Apply it:

- Drop every `rejected`
- Drop every `confidence < 60`
- Apply `severity` overrides from `downgraded`
- Where `correctedClaim` is non-null, replace the claim text

This step is the reason the output is trustworthy. Never present unverified findings, even when the user is in a hurry.

## Step 7 — Dedupe, rank, cap

Per `references/finding-schema.md`:

- Same `file` within ±3 lines and substantially the same claim → keep highest confidence, merge `evidence`, note the other agents that flagged it
- Sort `important` → `pre-existing` → `nit`; within each, confidence descending
- **Cap `nit` at 5**, `pre-existing` at 3; report the remainder as a count

## Step 8 — Preview locally

Print the report to the terminal. **Never post before showing this.** Lead with the shape of the work, then the detail:

```
PR #1852 — Add invoice detail mapping
621 raw lines / 675 weighted · depth deep · 5 agents
14 candidates → 6 after verification (8 rejected)

🔴 IMPORTANT (2)

1. src/billing/invoice-detail.mapper.ts:153
   Bare 'Y' comparison drops lowercase/padded flags
   item.paid === 'Y' returns false for 'y' or ' Y ', silently marking
   paid invoices as unpaid.
   Evidence:
     - invoice-detail.mapper.ts:153 — bare comparison
     - invoice-catalog.service.ts:104 — repo elsewhere trims + uppercases
   Fix: use the shared isFlagged helper.
   [review-silent-failure · confidence 85]

🟣 PRE-EXISTING (1)
...

🟡 NITS (3 shown, 2 more suppressed)
...
```

If nothing is `important`, say so on the first line: **"No blocking issues."** The author wants the shape before the details.

## Step 9 — Ask before posting

Never post without an explicit answer. Offer: post all, post `important` only, post nothing. Default to **important only**, because nits are better delivered in the terminal than as GitHub notifications. If the user declines, the terminal report stands on its own.

**Under Orbit** (the `ORBIT_LANE` environment variable is set), call `mcp__orbit__review_preview` with the findings you would post, then end your turn. Map severity as `important` to `major`, `pre-existing` to `minor`, and `nit` to `suggestion`. Send `n`, `severity`, `file`, `line`, the title as `gist`, and the whole comment exactly as it should land on GitHub (Step 10 format) as `body`. The user drops comments and picks the review status in Orbit, and Orbit posts the review itself. Do not post it and do not ask. You hear back only if Orbit couldn't post it, and then you post what the reply names per Step 10, keeping the status the user picked.

## Step 10 — Post (only after approval)

Build a single review payload — one review, not N separate comments:

```json
{
  "commit_id": "<headRefOid>",
  "event": "COMMENT",
  "body": "<summary with the tally>",
  "comments": [
    { "path": "src/billing/invoice-detail.mapper.ts", "line": 153, "side": "RIGHT", "body": "..." }
  ]
}
```

```bash
gh api repos/{owner}/{repo}/pulls/<NUMBER>/reviews --method POST --input <session-workspace>/review.json
```

`event` must be `COMMENT` when you post on your own. Never `APPROVE`, never `REQUEST_CHANGES` from this skill. Approval is a human decision. The one exception is an Orbit reply that names the status the user picked, which you pass through unchanged.

Comment body format:

```markdown
**🔴 Bare 'Y' comparison drops lowercase/padded flags**

`item.paid === 'Y'` returns false for `'y'` or `' Y '`, silently marking paid invoices as unpaid.

**Fix:** use the shared `isFlagged` helper (trim + uppercase) rather than a bare equality check.

<details><summary>Evidence</summary>

- `invoice-detail.mapper.ts`, line 153: bare comparison
- `invoice-catalog.service.ts`, line 104: repo elsewhere normalizes with `.trim().toUpperCase()`

</details>

<sub>review-silent-failure · confidence 85</sub>
```

**Line-number caveat:** GitHub rejects inline comments on lines outside the diff. If the API returns 422, retry that finding as a top-level PR comment with the file and line in the text rather than dropping it.

Report what was posted and link the review URL.

## Re-review convergence

If the PR already has a review from this skill, suppress **all** new nits and post `important` findings only. A one-line fix must not reach round seven on style.

## Notes

- Agents are read-only by construction. If a finding warrants a code change, that is a separate, explicitly approved step: offer it, don't do it.
- The diff file and review payload belong in the session workspace, never committed.
- Adding a repo-root `REVIEW.md` lets you tune severity, nit caps, and skip rules without editing these agent files.
- Repo-specific review facts (size bands, risk globs) live in the profile's `review` block. Repo-specific traps for the specialists live in the runbook the profile names under `runbook`.
