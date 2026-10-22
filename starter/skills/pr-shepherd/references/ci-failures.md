# Autonomously fixing CI failures

The shepherd reuses `orbit-starter:ci-watch`'s failure classification, then goes further. ci-watch auto-fixes only
lint and format and reports the rest. The shepherd fixes the mechanical ones, hands failing tests to
`orbit-starter:test-healer`, and escalates the rest.

The dividing question for every failure: does the fix restore prior intent, or does it change behavior? Restoring
intent (a stale snapshot, a renamed import, a moved selector, an outdated mock) is mechanical, so fix it. Changing
behavior (an assertion failing because the actual contract changed, a logic branch that is genuinely wrong) is a
judgment call, so escalate it.

Read the repo profile (`.claude/orbit/repo.json`) for the commands. `gates.test`, `gates.lint`, and `gates.format` are
what you run locally. Read the runbook it names under `runbook` for the required checks and the known flakes.

## Getting the failure details

```bash
gh run view <run-id> --json jobs --jq '.jobs[] | select(.conclusion=="failure") | {name, steps:[.steps[]|select(.conclusion=="failure")|.name]}'
gh run view <run-id> --log-failed
```

## Flaky-test gate (check this first)

Before treating a test or intermittent failure as real, check the runbook's known-flakes list. If the failure matches
one, or it looks like infrastructure noise such as a sign-in redirect timing out or a shard running slow:

```bash
gh run rerun <run-id> --failed
```

A rerun is refused while any job in the run is still going, so wait for the run to finish first. Watch the rerun. If
it goes green, it was flake: note it in the run summary and move on. If it fails the same way twice, it is real, so
fix it or escalate. Don't rerun more than once. Repeated reruns burn CI minutes and mask a real failure.

## Mechanical fixes by category

### Format: auto-fix and push

Run the formatter in write mode, the same tool the profile's `gates.format` checks with, on the changed files. Commit
with a plain subject such as "Fix formatting to pass CI" and push.

If the repo pins its formatter, run the pinned copy from the worktree, not a global one: a different major version
formats differently and CI stays red. Line endings can make a local check flag every file on some machines. Trust the
CI log over a local check, and run the formatter on just the changed files with its end-of-line option set to auto.
The runbook lists the repo's own quirks here.

### Lint: auto-fix and push

Run the lint tool with its fix option on the failing project, then fix by hand what auto-fix can't (an explicit
`any`, a missing type). Verify with the profile's `gates.lint`. Commit with a plain subject such as "Resolve lint
violations for CI" and push.

### Tests (unit and E2E): dispatch `orbit-starter:test-healer`

Reproduce first with the profile's `gates.test`, narrowed to the failing test where the tool allows. Then dispatch
test-healer with the failing test and its CI log. A brief that works:

> Failing test `<name>` in `<file>` (project `<project>`). The CI log is below. Decide whether this is a real
> failure, a flake, or a broken locator, selector, mock, or snapshot. If it is test maintenance that restores prior
> intent, fix it and run the gate to confirm. If it is a real regression in app behavior, do not change the test to
> hide it: report what behavior changed and why.

test-healer never weakens a test to get green, and neither do you. If it reports a real failure, escalate. Never let
a fix change business logic just to make a test pass. Mechanical causes it handles: an outdated snapshot (update only
after confirming the new output is correct), a mock that drifted from the real API contract, a renamed or moved
import, a changed selector, a missing shared mock setup, a needed wait.

When the root cause of a test failure is still unclear after one honest pass and it doesn't look like test
maintenance, dispatch `orbit-starter:debugger` with the same scope instead of guessing. It reports back; escalate if
the fix is not mechanical.

### Build and type errors: fix clear ones, escalate design changes

Clear and mechanical: a renamed export, a wrong import path, a missing type annotation, a moved file. Fix those and
verify with the build or type-check step the CI log shows failing (the profile has no separate build gate, so run
what CI ran). If the error implies a real design or contract change, such as a field that was genuinely removed or an
interface intentionally narrowed, escalate. The fix isn't yours to guess.

Also watch for dependency-boundary lint on a monorepo: moving an import between packages can require updating the
package's declared dependencies. That is still mechanical. The runbook notes the repo's specific rule.

### Dependency and install failures: escalate

Resolver and registry failures rarely have a safe autonomous fix. Report the package manager's error and stop.

### Unknown: escalate with the log

Print the failed job and step and the last 50 or so log lines, and stop. Don't guess at a category you couldn't
identify.

## Always verify before pushing

Run the affected gate locally and confirm it passes before committing a fix. Pushing a guess and letting CI judge it
wastes a full CI cycle per guess and muddies the PR history. Evidence before assertions.

## Retry budgets

Per failing check, allow at most two fix-and-push cycles. If the same check fails a third time:

- Stop fixing it.
- Escalate with what the failure is, both fixes you tried, and why you think it isn't converging.

A fix that doesn't stick after two honest attempts usually means the root cause is deeper than the symptom. That is
when a person should look, not when you try a third guess. This is tighter than ci-watch's three-cycle backstop
because the shepherd runs unattended.
