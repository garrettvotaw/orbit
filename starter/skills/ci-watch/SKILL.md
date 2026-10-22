---
name: ci-watch
description: Watch a GitHub Actions CI run, auto-fix lint and format failures, and report test and build failures with a diagnosis and a hand-off to orbit-starter:test-healer. Use when the user wants a run watched or asks why CI is red.
user-invocable: true
---

Watch a GitHub Actions workflow run, auto-fix lint and formatting failures by pushing fixes, and report test failures
with actionable next steps.

## Instructions

You are monitoring a GitHub Actions CI run. When it finishes, you diagnose failures and either auto-fix (lint and
format) or report with suggestions (tests and build).

**Input**: $ARGUMENTS

- No arguments: watch the most recent run on the current branch.
- A run ID (numeric): watch that specific run.
- `--branch <name>`: watch the most recent run on a specific branch.
- `--pr <number>`: watch the most recent run for a PR.

**Platform rules**:

- CI here is GitHub Actions. Use the `gh` CLI for all GitHub operations.
- Read the repo profile (`.claude/orbit/repo.json`). `gates.lint` and `gates.format` are the local commands that
  reproduce a lint or format failure, and `gates.test` reproduces a test failure. `baseBranch` is the base to diff
  against. A missing key means skip that step.
- Read the runbook when the profile names one under `runbook`. Its required-checks list says which red checks matter,
  and its known-flakes list says which failures get a rerun before anyone digs.

---

## Phase 1: IDENTIFY THE RUN

### 1a. Resolve which run to watch

- **No arguments**: `gh run list --branch $(git branch --show-current) --limit 1 --json databaseId,status,conclusion,name,event,headBranch`
- **Run ID provided**: `gh run view <id> --json databaseId,status,conclusion,name,event,headBranch`
- **`--branch <name>`**: `gh run list --branch <name> --limit 1 --json databaseId,status,conclusion,name,event,headBranch`
- **`--pr <number>`**: `gh pr view <number> --json headRefName`, then use that branch name.

If no run is found, tell the user and stop.

A PR can have several workflows, each with its own run. If the most recent run isn't the red one the user cares
about, list the runs for the head commit and ask which to watch.

### 1b. Print initial status

```
Watching: [workflow name], Run #[id]
Branch: [branch name]
Status: [in_progress / queued / completed]
Started: [time]
```

---

## Phase 2: POLL UNTIL COMPLETE

Check the run status every 30 seconds:

```bash
gh run view <id> --json status,conclusion
```

- **`in_progress` or `queued`**: wait 30 seconds and check again. Print a brief update every 2 minutes:
  ```
  Still running... [elapsed time]
  ```
- **`completed`**: proceed to Phase 3.

**Timeout**: after 30 minutes of polling, print a warning and ask the user whether to keep waiting.

---

## Phase 3: EVALUATE RESULT

### 3a. If conclusion is `success`

```
CI PASSED: Run #[id] completed successfully in [duration]
```

Stop here. Nothing else to do.

### 3b. If conclusion is `failure`

Fetch the failed jobs and steps:

```bash
gh run view <id> --json jobs --jq '.jobs[] | select(.conclusion == "failure") | {name, conclusion, steps: [.steps[] | select(.conclusion == "failure") | {name, conclusion}]}'
```

Then fetch the failed log:

```bash
gh run view <id> --log-failed
```

Check the runbook's known-flakes list before classifying. A failure that matches a listed flake gets one rerun of the
failed jobs (`gh run rerun <id> --failed`, which GitHub refuses while any job in the run is still going) and then
Phase 2 on the rerun. Anything else, classify into one of the categories below and go to its handler.

---

## Phase 4: HANDLE FAILURES

### Category A: Format failure

**Detection**: the log names the formatter, a format check step, or file-level formatting diffs.

**Action** (auto-fix and push):

1. Run the formatter in write mode on the changed files, the same tool `gates.format` checks with. If the repo pins
   it, use the pinned copy from the worktree.
2. Commit with the subject `Fix formatting to pass CI`.
3. Push with `git push`.
4. Print:
   ```
   Auto-fixed: formatting
   Pushed fix commit. CI should re-trigger.
   ```
5. Go back to Phase 2 to watch the new run.

A local format check can disagree with CI, for example when line endings differ on a checked-out copy. Trust the CI log.

---

### Category B: Lint failure

**Detection**: the log contains the linter's name, a lint step, or lint rule names.

**Action** (auto-fix and push):

1. Parse the output to identify which projects failed and which rules were violated.
2. Run the lint tool with its fix option on each failing project.
3. If the fix option doesn't resolve everything (an explicit `any`, a missing type), fix the rest by hand.
4. Run `gates.lint` locally to verify.
5. Commit with the subject `Resolve lint violations for CI`.
6. Push with `git push`.
7. Print:
   ```
   Auto-fixed: lint violations in [project(s)]
   - [list of rules fixed]
   Pushed fix commit. CI should re-trigger.
   ```
8. Go back to Phase 2 to watch the new run.

---

### Category C: Unit test failure

**Detection**: the log contains the test runner's name, `FAIL`, test file names, or assertion errors.

**Action** (report and suggest):

1. Parse the log to extract the failing test files, the failing tests in each, the assertion error (expected vs.
   received), and the project name.
2. Run the failing test locally to confirm it reproduces, using `gates.test` narrowed to the file where the tool allows.
3. Read the failing test file and the source it tests.
4. Diagnose the likely cause:
   - **Assertion mismatch**: a value changed and the test wasn't updated.
   - **Missing mock**: a dependency isn't mocked, so the real call fails.
   - **Import error**: a file moved or was renamed.
   - **Snapshot outdated**: the snapshot needs an update.
5. Print the diagnosis:

   ```
   CI FAILED: Unit Test Failure

   **Project**: [project name]
   **Test file**: [path]
   **Failing test(s)**:
   - [test name]: [brief cause]

   **Diagnosis**: [explanation of what went wrong]

   **Suggested fix**: [specific code change or command]

   To fix it, hand the failing test and this log to orbit-starter:test-healer.
   It decides real failure vs flake vs broken locator and never weakens a test to get green.
   ```

---

### Category D: E2E test failure

**Detection**: the log contains the browser test runner's name, `e2e`, browser-related errors, or an E2E project name.

**Action** (report and suggest):

1. Parse the log to extract the failing spec files and tests, the error message (timeout, assertion, element not
   found), and any screenshot or trace URLs in the log.
2. Read the failing spec and its page object.
3. Diagnose the likely cause:
   - **Selector changed**: the component library's markup or a label changed.
   - **Mock setup missing**: the shared mock setup the specs rely on wasn't called.
   - **Timing issue**: the element wasn't ready and needs a wait.
   - **Real regression**: a source change broke behavior.
4. Print the diagnosis:

   ```
   CI FAILED: E2E Test Failure

   **Project**: [project name]
   **Spec file**: [path]
   **Failing test(s)**:
   - [test name]: [brief cause]

   **Diagnosis**: [explanation]

   **Suggested next step**:
   Hand the failing spec and this log to orbit-starter:test-healer.
   It tells a real regression from a broken locator or a flake, and fixes only the latter two.
   ```

---

### Category E: Build or compilation failure

**Detection**: the log contains the compiler's name, type error codes, a build step, compilation errors, or `Cannot
find module`.

**Action** (report and suggest):

1. Parse the error(s): the error code, the file and line number, and the message.
2. Read the offending file(s).
3. Diagnose:
   - **Type mismatch**: an argument type doesn't match its parameter.
   - **Missing export**: an import path is broken or an export was removed.
   - **Missing module**: a dependency isn't installed or the import path is wrong.
4. Print the diagnosis:

   ```
   CI FAILED: Build Error

   **Error**: [error code] in [file] at line [line]
   **Message**: [compiler error message]

   **Diagnosis**: [explanation]

   **Suggested fix**: [specific code change]

   Want me to fix this? Just say "fix it".
   ```

---

### Category F: Dependency or install failure

**Detection**: the log contains the install command, a resolver error, or package resolution errors.

**Action** (report only):

```
CI FAILED: Dependency Installation Error

**Error**: [package manager error message]

This usually needs a person:
- Check the manifest for version conflicts
- Reproduce the install locally
- Check that any private registry is reachable
```

---

### Category G: Unknown failure

**Detection**: doesn't match any category above.

**Action** (report the raw log):

```
CI FAILED: Unrecognized Failure

**Failed job**: [job name]
**Failed step**: [step name]

**Log excerpt** (last 50 lines):
[raw log output]

Couldn't auto-classify this failure. Review the log above and tell me how to proceed.
```

---

## Phase 5: POST-FIX MONITORING

After pushing an auto-fix (Categories A or B):

1. Wait 10 seconds for GitHub to register the push.
2. Fetch the new run: `gh run list --branch <branch> --limit 1 --json databaseId,status`
3. If a new run started, go back to Phase 2 and watch it.
4. If no new run started after 30 seconds, tell the user:
   ```
   Fix pushed but no new CI run detected. You may need to re-trigger manually:
     gh workflow run <workflow-name> --ref <branch>
   ```

**Max auto-fix cycles**: 3. If CI fails 3 times in a row with auto-fixable issues, stop and report:

```
Stopped after 3 auto-fix cycles. Something deeper may be wrong.
[Summary of all fixes attempted]
```

---

## Phase 6: FINAL REPORT

After the run completes (pass or fail, after all fix cycles), print:

```
## CI Watch Summary

**Run**: #[id] on [branch]
**Result**: [PASSED / FAILED]
**Duration**: [total elapsed time including fix cycles]

### Fix cycles:
- Cycle 1: [what was fixed, or "original run"]
- Cycle 2: [what was fixed]
- ...

### Final status:
- [PASSED / FAILED: category and details]

### Action needed:
- [None / specific next step]
```
