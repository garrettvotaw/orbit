---
name: address-pr-comments
description: Address open PR review comments by either fixing the code or justifying it, draft replies for the user's approval, then post them to GitHub. Use whenever the user wants to respond to, reply to, or handle reviewer feedback on a pull request, with phrases like "address PR comments", "respond to review", "handle reviewer feedback", "reply to PR comments", or "answer review feedback".
user-invocable: true
---

Address open reviewer comments on a GitHub PR. For each comment, decide whether to fix the code or justify the
existing code, then draft a reply for the user to review before posting everything to GitHub.

## Instructions

You are helping the author respond to reviewer feedback. For each open comment you'll either (a) make a code change
and draft a short reply explaining it, or (b) draft a reply that justifies the current code. After the user approves
the drafts, you post them to GitHub in one pass.

**Input**: `$ARGUMENTS`, a PR number or URL (required). If missing, ask the user and stop.

Read the repo profile (`.claude/orbit/repo.json`) first. `gates` holds the quality-gate commands for Phase 3, and
`resolveThreads` (`ask`, `auto`, or `never`, default `ask`) decides what happens to threads after you reply. A
missing key means skip that step.

When `orbit-starter:pr-shepherd` or `orbit-starter:pr-fixer` runs this skill unattended, their instructions replace
the approval gate. Run by hand, the gate stands.

### Hard rules

1. **User-specified PR only.** Do not auto-detect from the current branch. If no PR is given, ask.
2. **Only unresolved, open threads.** Skip anything already resolved, outdated, or dismissed.
3. **Handle all comment types:** inline review comments, top-level PR review bodies, and general issue-style
   conversation comments.
4. **One commit for all fixes.** Never split into multiple commits.
5. **Threads follow `resolveThreads`.** `never`: post replies only, and the reviewer decides when a thread is
   resolved. `ask` (the default): never resolve on your own; offer it once, as part of the approval batch (see Phase
   4). `auto`: resolve a thread after its reply is posted and its fix has pushed (see Phase 5).
6. **Approval before posting.** Never post replies until the user explicitly approves the batch.
7. **Natural teammate tone.** Write replies like a senior dev would: direct, specific, no AI filler.

---

## Phase 1: Gather PR and comments

### 1a. Validate environment

```bash
gh auth status
git status --short
git branch --show-current
```

- If `gh` isn't authenticated, stop and ask the user to run `gh auth login`.
- If the working tree has uncommitted changes, warn the user and ask whether to proceed, stash, or abort. Don't
  silently blow past dirty state.

### 1b. Resolve the PR and check out the branch

From `$ARGUMENTS`, extract the PR number (accept a raw number, a `gh` URL, or a full GitHub URL).

```bash
gh pr view <number> --json number,title,headRefName,baseRefName,author,url,isDraft,state
```

If the PR isn't on the current branch, check it out:

```bash
gh pr checkout <number>
```

Note the base branch. You'll need it later for the diff when scoping fixes.

### 1c. Fetch all open comments

Pull each comment category and keep only the actionable ones. Prefer the GitHub MCP tools when they are available
(`mcp__github__get_pull_request_comments`, `mcp__github__get_pull_request_reviews`); fall back to `gh api`.

```bash
# Inline review comments (line-level)
gh api repos/{owner}/{repo}/pulls/<number>/comments --paginate

# Review bodies (top-level review comments)
gh api repos/{owner}/{repo}/pulls/<number>/reviews --paginate

# Conversation/issue-style comments
gh api repos/{owner}/{repo}/issues/<number>/comments --paginate
```

**Filter out:**

- Comments authored by the PR author (self-notes).
- Outdated inline comments (`position == null` on inline comments usually means the line moved; skip unless clearly
  still relevant).
- Reviews with no body and no comments (pure APPROVE or REQUEST_CHANGES noise).
- Threads whose resolved state is detectable and `true`. Use the GraphQL `reviewThreads` query when precision matters:

```bash
gh api graphql -f query='
  query($owner:String!,$repo:String!,$num:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        reviewThreads(first:100){
          nodes{ id isResolved isOutdated comments(first:50){ nodes{ id databaseId body path line author{login} } } }
        }
      }
    }
  }' -F owner=<owner> -F repo=<repo> -F num=<number>
```

Collect every surviving comment into a working list with `id`, `type` (inline, review_body, or conversation),
`author`, `path` and `line` (if inline), `body`, and `thread_id` (for inline, to reply and resolve correctly).

### 1d. Read the code in context

For every inline comment, read the surrounding file, not just the hunk. You can't decide "fix vs justify" without
seeing how the code is actually used. For review bodies and conversation comments, read whichever files the comment
references.

Also pull the PR diff so you know what actually changed:

```bash
gh pr diff <number>
```

---

## Phase 2: Decide fix vs justify (per comment)

For each comment, form a judgment:

- **Fix**: the reviewer found a real issue, or their suggestion is a clear improvement with low risk.
- **Justify**: the current code is correct, intentional, or the tradeoff favors keeping it. You'll explain why in the
  reply.
- **Ambiguous**: reasonable in both directions, or it depends on context you don't have (product intent, team
  convention, deployment constraint).

For ambiguous cases, **ask the user** before acting. Batch the ambiguous ones into a single question set instead of
asking one at a time:

```
A few of these could go either way. Which direction for each?

1. [inline] src/foo.ts line 42: reviewer says "use lodash.groupBy here"
   Fix: swap the manual reduce for groupBy. Justify: the manual version avoids a lodash dependency.

2. [conversation] reviewer asks why we don't memoize
   Fix: add memo and a test. Justify: called once per render path, memo adds complexity for no real win.

For each, reply with 1=fix, 1=justify, 2=fix, 2=justify, etc.
```

Wait for the user's direction before proceeding. Don't guess.

**Things that push toward "justify":**

- The reviewer's suggestion would regress a constraint documented elsewhere (performance, security, backwards
  compatibility).
- The existing pattern matches the surrounding codebase and the suggestion would be an island.
- The comment is a question, not a demand ("why did you do it this way?").
- The reviewer may have missed context that is visible in the surrounding file.

**Things that push toward "fix":**

- Off-by-one, null handling, a leaked subscription, a missed branch: the reviewer is right.
- Naming or readability suggestions in code you touched in this PR (cheap to do, adds clarity).
- Missing test coverage in risky territory the reviewer flagged.
- Convention violations specific to this repo.

---

## Phase 3: Apply fixes

For every comment marked **fix**:

1. Make the code change. Keep it tightly scoped to what the reviewer asked, and don't refactor surrounding code.
2. Track which comment the change came from (you'll reference this in the reply).
3. Do NOT commit yet. Fixes accumulate across comments and commit together.

After all fixes are in:

```bash
git status
git diff
```

Run the quality gates the repo profile names for the changed code: `gates.lint` and `gates.test`, plus `gates.format`
when set. If a check fails, investigate. Don't suppress errors or bypass hooks. Report failures to the user and stop;
don't post replies claiming a fix works when it doesn't.

Once checks pass, create a single commit:

```bash
git add <changed-files>
git commit -m "$(cat <<'EOF'
Address PR review feedback

<one-line summary per comment addressed>
EOF
)"
```

Add the commit trailer your setup uses for AI-assisted commits. Then push:

```bash
git push
```

If nothing was fixed (all comments were justified), skip the commit entirely. Don't make an empty commit.

---

## Phase 4: Draft replies and present as a batch

For each comment, draft a short reply.

### Reply tone

Every reply follows these rules, and they are non-negotiable:

- **No AI filler.** Never write "Great point!", "Thanks for the feedback!", "Consider leveraging...", "It would be
  prudent to...", or "You're absolutely right...".
- **Direct and specific.** Say what you did or why the code stays. Reference the actual change or the actual reason.
- **Brief.** One to three sentences. A code snippet is fine when it clarifies; don't pad.
- **First person, matter-of-fact.** Write like you'd talk to the reviewer in chat.
- **For fixes:** name the change so the reviewer can find it in the new commit. Don't link to the commit SHA; they'll
  see it in the PR timeline.
- **For justifications:** explain the reason, not just "this is intentional". If there's a constraint or a prior
  decision, say so. If the reviewer may have missed context, point to it without being condescending.

**Good fix reply:**

> Good catch, switched to filtering by `deliveryId` so we pick the right delivery when there are multiples.

**Good justify reply:**

> Leaving as-is. The manual reduce here avoids pulling lodash into the client bundle, which we've been keeping lean.
> Happy to revisit if bundle size stops being a concern.

**Bad reply (do not write like this):**

> Thank you for the excellent suggestion! I have taken your feedback into consideration and made the appropriate
> changes to address this concern. Please let me know if further modifications are needed.

### Present the batch

Show all drafts together, numbered, grouped by type:

```
## PR #<number>: <N> replies drafted

### Inline comments (<count>)

1. src/foo.ts line 42, @reviewer said "this could group by key"
   Action: FIX (committed)
   Reply: Good catch, switched to lodash.groupBy.

2. src/bar.ts line 18, @reviewer said "missing null check"
   Action: JUSTIFY
   Reply: The caller guarantees non-null here via the DTO validator; adding a guard would be dead code.

### Review body (1)

3. @reviewer's review: "overall looks good, minor questions inline"
   Action: REPLY
   Reply: Thanks, addressed the inline ones. Commit pushed.

### Conversation (<count>)

4. @reviewer said "why no memoization?"
   Action: JUSTIFY
   Reply: This renders once per mount, so memo would add complexity without saving work.

---
Fixes committed: <commit-sha-short> "<commit subject>"
```

When `resolveThreads` is `ask` and there are inline threads, add one line under the batch: "Resolve the replied
threads after posting? (yes / no)". Outside Orbit that is an inline question. Inside Orbit, raise it as a needs_you
with "Post and resolve", "Post only", and "Edit first".

Then prompt:

**Edit any reply (for example "2: <new text>"), remove any by number (for example "3, 4"), or hit Enter to post all.**

Handle the response:

- Numbers like `2, 4` drop those replies.
- `<n>: <text>` replaces reply n with the new text (accept multi-line if they provide it).
- `none`, or removing all, skips Phase 5 and just confirms the fix commit.
- Empty or Enter posts everything as-is.

Loop the preview until the user approves, re-displaying the updated batch after each edit round.

---

## Phase 5: Post replies

Post each approved reply through the appropriate GitHub endpoint. Prefer the GitHub MCP tools when available.

### Inline comments (reply in-thread)

Reply to the thread, not as a new top-level comment, so it threads correctly:

```bash
gh api repos/{owner}/{repo}/pulls/<number>/comments \
  --method POST \
  -f body="<reply text>" \
  -F in_reply_to=<original_comment_id>
```

### Review body replies

GitHub doesn't thread review-body replies. Post them as a conversation comment that @-mentions the reviewer so it's
clearly a response:

```bash
gh api repos/{owner}/{repo}/issues/<number>/comments \
  --method POST \
  -f body="@<reviewer-login> <reply text>"
```

### Conversation (issue-style) replies

```bash
gh api repos/{owner}/{repo}/issues/<number>/comments \
  --method POST \
  -f body="@<reviewer-login> <reply text>"
```

Post replies sequentially and report any API errors as they happen. Don't halt the whole batch on a single failure.
Post what you can, then list the ones that failed so the user can retry.

### Resolving threads

Only per `resolveThreads`. `never`: skip this. `ask`: only for the threads the user said yes to in the batch. `auto`:
every inline thread whose reply posted and whose fix, if any, has pushed. Resolve with the thread id from Phase 1c:

```bash
gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' -f id=<thread_id>
```

---

## Phase 6: Confirm

Print a concise summary:

```
Done: PR #<number>
  Fixes:    <count> comments addressed via commit <sha-short>
  Replies:  <count> posted (<inline> inline, <review> review, <conv> conversation)
  Resolved: <count> threads (or "left to the reviewer")
  Skipped:  <count> (resolved/outdated)
```

If any replies failed to post, list them with the error so the user can retry manually.

---

## Notes on judgment

- **Keep scope tight.** You're responding to specific comments, not doing a general cleanup pass. If you notice
  unrelated issues, mention them to the user afterward. Don't bundle them into the fix commit.
- **When a reviewer asks a question, a reply is the answer.** Not every comment needs a code change. If the reviewer
  is trying to understand the code, a clear explanation is often the right outcome.
- **Don't argue just to argue.** If the reviewer's suggestion is a clear win, do it. Justification isn't a loyalty
  test for the original code.
- **If you're unsure whether a comment is resolved,** ask the user rather than assuming. Some teams resolve threads;
  others don't, and `resolveThreads` says which this repo is.
