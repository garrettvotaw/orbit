# Repo profile

`.claude/orbit/repo.json`, committed so the team shares it. The starter's skills read it for everything that
differs between repos. The schema is `schema/repo.schema.json`; the examples under `examples/` validate against
it.

A missing optional key is never an error. The skill that would use it skips that step.

Paths in the profile are relative to the repo root.

Optional top-level sections (`review`, `qa`, `stack`) are added by the pieces that read them.

## Keys

| Key | Required | What it holds |
| --- | --- | --- |
| `baseBranch` | yes | Branch PRs target and worktrees start from. |
| `branchTemplate` | yes | Branch name pattern, e.g. `{prefix}/{id}-{slug}`. |
| `prefix` | yes | Fills `{prefix}` in the template. |
| `worktree.copy` | yes | Gitignored files to copy from the main checkout (an `.env`, a license file). Can be empty. |
| `worktree.link` | yes | Paths to share with the main checkout through a symlink or junction (usually `node_modules`). Can be empty. |
| `worktree.install` | no | Command that installs dependencies in a fresh worktree. |
| `gates.test` | yes | Test command, scoped to what changed where the tool can. |
| `gates.lint` | no | Lint command. |
| `gates.format` | no | Format-check command. |
| `serve` | no | How to run the app locally, when a lane needs it. |
| `prLink` | no | How a PR names its story. Defaults by tracker: `AB#{id}` (ADO), `{key}` (Jira), `Closes #{id}` (GitHub Issues). |
| `lanes` | yes | Path globs to build-lane agents, as `{ glob, agent }`. Anything unmatched goes to `orbit-starter:builder`. Name agents with the plugin prefix. |
| `consults` | yes | Which consults run. All members are optional, see below. |
| `maxOpenPrs` | no | Open-PR cap the engine reads from `gh`. Default 8. Separate from Orbit's `storyWipCap`. |
| `merge` | no | `ask`, `auto`, or `never`. Default `ask`. |
| `resolveThreads` | no | `ask`, `auto`, or `never`. Default `ask`. |
| `runbook` | no | Path to a markdown file of repo facts: required checks, known flakes, reviewer team, false trails. The PM, debugger, monitor, and fixers read it. |

## Consults

- `requirements`, `architect`, `testData`: `true` to run that consult.
- `ux`: `true` turns it on, and the story's triage decides whether it runs. `{ "when": "..." }` adds a condition that forces it.
- `integration`, `legacy`: the agent that handles that consult. Leave them out and the consult doesn't run.

## QA

`qa: { "enabled": true }` allows `orbit-starter:qa-tester`. Without it the tester never runs. Optional
`deployWorkflow` names the CI workflow that deploys the QA target, and `testStates` lists the board columns that
hold stories waiting for QA. The harness, URLs, login, and safe-data rules go in the runbook's QA section.
`consults.testData` separately turns on `orbit-starter:test-data-scout`.

## Stack

`stack: { "enabled": true }` allows `orbit-starter:stack`. `layers` orders slices base first
(`{ id, title?, paths }`). `graph` is `"nx"` or a command printing the project graph, and is optional. `spine`
lists shared files assigned key by key. `verify` is the per-slice build command with `{base}`, run in the slice's own
worktree (its base plus that slice only). It defaults to `gates.lint` plus `gates.test`, which proves a build only if
the test command compiles everything. A repo whose test command doesn't sets `stack.verify` to its build-and-test
command. `cutRoot` and `maxPrsPerRun` (default 3) tune the cutting worktree and PR bursts.

`prLink` applies to the top slice, the one that completes the story, exactly as written. Every other slice uses it
with a leading closing keyword (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved, with an
optional colon) stripped, so `Closes #{id}` becomes `#{id}` and merging an early slice doesn't close the story.

## Merge policy

`merge` and `resolveThreads` share one rule: `ask`, `auto`, or `never`. With the default `ask`, when a PR is
approved and green the monitor raises `needs_you` with "Merge #12?" and waits. Several PRs ready together
batch into one ask, with a button per PR plus "Merge all" and "Not yet". `auto` merges (or resolves) without
asking. `never` leaves it to you.

Every skill that can merge or resolve reads these two keys, so the monitor, the shepherd, and the
comment-addressing skill agree.

## Lane order

Lanes match top to bottom and the first match wins. Put the narrower globs first.

## Review

The optional `review` block tunes `orbit-starter:pr-review-swarm` and its agents. Leave it out and they use
generic defaults and measure the repo themselves.

- `sizeBands`: line counts `orbit-starter:review-bloat` judges growth against. Keys are `fileNit`, `fileImportant`,
  `fileGrowth`, `functionNit`, and `functionImportant`, all integers. A missing key means the agent measures the
  repo's own file-size percentiles (95th for `fileNit`, 99th for `fileImportant`).
- `riskGlobs`: extra `{ glob, weight, bucket }` rules for `scripts/risk-size.js`, checked before its built-in globs.
  First match wins. `weight` multiplies changed lines (0 means nobody reviews the file). `bucket` is one of
  `generated`, `test`, `docs`, `style`, `auth`, `contract`, `integration`, `state`, `server-logic`, `client`, or
  `other`, and decides which review agents run.

```json
"review": {
  "sizeBands": { "fileNit": 300, "fileImportant": 700 },
  "riskGlobs": [{ "glob": "apps/api/src/billing/**", "weight": 3, "bucket": "integration" }]
}
```
