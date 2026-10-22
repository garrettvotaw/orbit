---
name: ac-verify
description: Gate a branch on its story's acceptance criteria before a PR opens. Reads the AC with Orbit's get_story, diffs against the right base, proves each AC with code plus a test (writing the test when one is missing), fixes failures and reruns the repo profile's gates for up to three loops, then posts the evidence matrix to the PR body, the story (comment_on_story with marker ac-evidence), and Orbit. Run by the orbit-starter:ac-verifier agent, which the story manager dispatches; the user can also run it by hand.
user-invocable: true
---

Gate the current branch on every acceptance criterion from its story. This is a gate, not a report: an AC passes
only when there's implementing code and a test that exercises it, and a failing AC gets fixed here, not handed back.

**Input**: $ARGUMENTS

- No arguments: take the story id from the branch name.
- `{id}`: use that story id.

Run by the `orbit-starter:ac-verifier` agent, the dispatch brief stands in for the arguments: it names the story
id, the worktree to work in, the branch and its base, and the mode.

**Platform rules**:

- The tracker is for stories only, and you reach it only through Orbit's board tools (`mcp__orbit__get_story`,
  `mcp__orbit__comment_on_story`). Never a tracker CLI or API.
- GitHub is for **all git operations**: branches, commits, pushes, PRs.
- The repo profile (`.claude/orbit/repo.json`) names the branch pattern: `branchTemplate` filled with `prefix`.

**This runs before any PR opens.** When the user asks to create a PR, run this first. Only go on to the PR after
every AC passes or the user explicitly chooses to proceed despite gaps.

---

## Mode

```bash
git branch --show-current
gh pr view --json author -q .author.login   # the open PR's author, if there is one
gh api user -q .login                       # you
```

| Branch | Mode | What it may do |
| --- | --- | --- |
| Yours: the dispatch brief says `mode: gate`, or the branch fits the profile's `branchTemplate` with its `prefix` and any open PR on it is yours | **gate** | Everything below: write tests, fix code, commit, push to an open PR, comment on the story, edit the PR body |
| Anyone else's | **report-only** | Steps 1 to 3 without writing tests or editing code. No commits, story comments, or PR body edits |

With no repo profile, the branch is report-only unless the user says it's theirs. Record the mode in the JSON.
Report-only still writes the JSON and the matrix and posts the Orbit status.

---

## Step 0: Resolve the story id

1. If `$ARGUMENTS` (or the brief) names an id, use it.
2. Otherwise read it out of the branch name, in the `{id}` slot of the profile's `branchTemplate`: with
   `{prefix}/{id}-{slug}`, `feat/100204-saved-cart` gives `100204` and `feat/ACME-123-saved-cart` gives `ACME-123`.
   With no profile, take the first run of digits after the last `/`.
3. If neither works, ask: "I couldn't find a story id in the branch name. What's the story id for this branch?"
   Stop and wait. Under the agent, where nobody can answer, write the JSON as `ESCALATED` with that question
   instead.

---

## Step 1: Fetch the AC and diff against the right base

Run these in parallel.

### 1a. AC from the story

`mcp__orbit__get_story({ id: '<ID>' })`. Pull the title, the item type, and the acceptance criteria. For a bug
with no AC, use its repro steps.

If the tool isn't in your tools, or it refuses (the board hasn't loaded, the project has no tracker), you can't
verify anything. Write the JSON as `ESCALATED` with "Couldn't read story <ID>: <the reply>" and stop.

Split the criteria into AC items, one per distinct testable behavior (bullets, numbered lists, Given/When/Then
blocks, or plain paragraphs). Number them AC 1, AC 2, and so on.

If there's no AC, write the JSON with `status: "NO_AC"` and an empty `acs` array, say "Story <ID> has no
acceptance criteria defined. Cannot verify. Proceeding without AC gate.", and stop without blocking PR creation.

### 1b. Diff against the base

Find the base branch, first match wins:

1. The open PR's base: `gh pr view --json baseRefName -q .baseRefName`
2. The branch's parent in the `orbit-starter:stack` skill's registry, `~/.claude/stack-registry.json`, when there
   is one
3. The profile's `baseBranch` (`main` with no profile)

```bash
git fetch origin <base>
MERGE_BASE=$(git merge-base HEAD origin/<base>)
git diff --name-only $MERGE_BASE...HEAD
git diff $MERGE_BASE...HEAD
```

For a stacked branch the base is the parent, never the base branch. If files show up that the story has no reason
to touch, assume the base is wrong before assuming scope creep.

---

## Step 2: Write the verdict file, right away

Before analyzing anything, write `~/.claude/reports/ac-verify/<ID>.json` with every AC set to `PENDING`. Resolve
`~` to the home directory, since the Write tool needs an absolute path. A rerun overwrites the file.

```json
{
  "story": "100204",
  "title": "Saved cart survives sign-out",
  "type": "User Story",
  "branch": "feat/100204-saved-cart",
  "base": "origin/main",
  "mergeBase": "<sha>",
  "head": "<sha>",
  "mode": "gate",
  "loop": 0,
  "status": "PENDING",
  "acs": [{ "n": 1, "text": "<AC text>", "status": "PENDING", "code": [], "tests": [], "note": "" }],
  "filesTouched": [],
  "escalation": null,
  "updated": "<ISO timestamp>"
}
```

`status` at the top is `PENDING` while it runs, then `PASS`, `FAIL`, `ESCALATED`, or `NO_AC`. Whoever called this
skill reads the file, not the transcript, so keep it current.

---

## Step 3: Prove each AC

Work through the ACs in order. For each one, find:

- **Code**: the file:line that implements the behavior. Read the whole file when the diff alone doesn't make the
  connection.
- **Test**: the file:line of a spec that exercises the behavior and asserts on it. A spec whose title names the
  behavior but whose assertions don't check it doesn't count, and neither does a locator that matches nothing.

If the code is there but no test exercises it, write one in gate mode, next to the code it covers, and run it with
the profile's `gates.test` narrowed to that project or file where the tool allows it. Follow the repo's test rules
wherever it writes them down (a `CLAUDE.md` beside the code, the runbook). Never put a story id in a test. Where the
repo says nothing, find elements by role, label, or text rather than by test ids. In report-only mode, record
`"note": "code found, no test"` instead.

Mark the AC:

| Status | When |
| --- | --- |
| **PASS** | Implementing code and a passing test that exercises it |
| **FAIL** | Code missing, test missing, or the test fails |

**Never invent evidence.** If you can't point at the line, it's a FAIL with a `note` saying what's missing. The
point is to catch gaps before QA does.

Update the JSON after each AC, not at the end.

---

## Step 4: Fix and loop (gate mode only)

If any AC is FAIL, one loop is:

1. Fix the implementation (or the test, if the test is what's wrong).
2. Rerun the gates and read the output:
   - the profile's `gates.test`, and `gates.lint` when it has one. Where a command names a base
     (`--base=origin/<baseBranch>`), swap in `$MERGE_BASE`, so a stacked branch is checked against its parent.
   - `gates.format`, when it has one: on just the changed files where the tool takes file arguments, and accepting
     either line ending (prettier's `--end-of-line auto`) so a Windows checkout doesn't flag every file.
3. Commit the fix and its test together with an imperative subject. Check `git branch --show-current` first; never
   commit to the base branch.
4. Re-verify **every** AC, not just the ones that failed, since a fix can break another one. Bump `loop` in the
   JSON.

Edit only files the branch already changed, plus spec files beside them. A fix that needs any other file is an
escalation; under Orbit that file may belong to another story. List every file you edit or create in
`filesTouched`.

**Three loops at most.** If anything is still FAIL after loop 3, or a fix needs a decision you can't make (an AC
that contradicts the code or the legacy app, a file outside the branch, a missing endpoint or flag), stop and
escalate:

- Set `status: "ESCALATED"` and put one precise question in `escalation`. Name the AC, what you tried, and the
  choice that unblocks it.
- End your output with that question. In an interactive session, ask the user.

Don't loop on a red gate that has nothing to do with the ACs (a flaky spec, a pre-existing lint error on the base).
Note it in the JSON and keep going.

---

## Step 5: Publish the matrix

When every AC passes, set `status: "PASS"` and write the matrix to `~/.claude/reports/ac-verify/<ID>.md`:

```markdown
## AC evidence

| AC  | Criterion       | Code                                         | Test                                              |
| --- | --------------- | -------------------------------------------- | ------------------------------------------------- |
| 1   | <short AC text> | `apps/web/src/cart/saved-cart.service.ts:42` | `apps/web/src/cart/saved-cart.service.spec.ts:88` |
```

Then, in gate mode:

- **PR body.** If the branch has an open PR, push any commits from Step 4 first, then replace the `## AC evidence`
  section in the body (or append it) with `gh pr view --json body` and `gh pr edit --body-file`. If there's no PR
  yet, the `.md` file is the hand-off and whoever opens the PR pastes it into the body.
- **The story.** Comment the matrix on the story, as markdown:
  `mcp__orbit__comment_on_story({ id: '<ID>', text: '<the matrix>', marker: 'ac-evidence' })`. The marker keeps one
  evidence comment: Orbit edits the comment it left before with that marker instead of adding a second. Read the
  reply:
  - "Updated the ac-evidence comment on <key>." The earlier one now holds this matrix.
  - "Commented on <key>." The first evidence comment on this story.
  - "Commented on <key>, but the tracker dropped the hidden "ac-evidence" marker, so the next "ac-evidence" comment
    will be a new one." The evidence still posted; the next run posts a fresh one. That is not a failure.

  Orbit only edits comments it marked itself, so an older evidence comment someone posted by hand stays as it is.
- **Orbit.** If `mcp__orbit__post_status` is available, post one line, like "AC gate passed for 100204, evidence on
  the story." If it isn't (a plain CLI session), make that line the last line of your output.

In report-only mode, write the `.md` and the Orbit line only.

If the run ends FAIL or ESCALATED, skip the PR body and the story comment. Post the Orbit line with the failing AC
numbers instead.

---

## Output

Keep it short. Lead with the result, then one line per AC, then the escalation question if there is one:

```
AC gate <ID>, <title>: PASS (5/5, 2 loops) · base origin/main · ~/.claude/reports/ac-verify/<ID>.json

[PASS] AC 1: <AC text> → <code file:line> · <test file:line>
[FAIL] AC 2: <AC text> → <what's missing>
```

On a standalone run, stop there and don't create a PR. Under the `orbit-starter:ac-verifier` agent, this output is
the agent's report.
