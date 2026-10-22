# orbit-starter

A Claude Code plugin with the agents and skills Orbit runs by default: a PM that hands stories to story managers, a story engine, and a PR review flow. It declares one dependency, the `superpowers` plugin.

## What ships

Agents, in `agents/`:

- `pm`: runs a project's board and hands each story to a story manager.
- `story-manager`: owns one story from the PM's brief to an open PR.
- `requirements`: turns a story into testable requirements.
- `architect`: read-only build plan with file ownership per lane.
- `ux-designer`: read-only UI spec for stories that touch the interface.
- `builder`, `frontend`, `backend`: build lanes. `builder` is the default for paths no lane matches.
- `debugger`, `test-healer`: root-cause and fix failing builds and tests.
- `ac-verifier`: proves each acceptance criterion with code and a test.
- `qa-tester`, `test-data-scout`: browser QA against a deployed app, and finding or building the data it needs.
- `review-*` specialists and `review-verifier`: the read-only reviewers the swarm dispatches.

Skills, in `skills/`:

- `delivery-pm-engine`: the PM's shared machinery (board, WIP cap, handing stories off).
- `story-engine`: one story from brief to PR.
- `ac-verify`: the pre-PR gate on acceptance criteria.
- `worktree-bootstrap`: sets up a fresh worktree from the repo profile.
- `monitor-prs`, `pr-shepherd`, `ci-watch`, `address-pr-comments`: watch, fix, and answer on your open PRs.
- `review-pr`, `pr-review-swarm`: review someone else's PR.
- `stack`: build a feature on one branch and derive stacked PRs.

Repo setup is in `docs/` (`repo-profile.md`, `pm-domain.md`); `examples/` has two filled-in repos and `schema/` the profile schema.

## How the plugin is named

Checked against Claude Code 2.1 with a throwaway agent and skill in a clean config dir.

- A plugin's agent is addressed as `orbit-starter:<agent>` and its skill as `orbit-starter:<skill>`. Asking a session to list its agents and skills shows `orbit-starter:probe-agent` and `orbit-starter:probe-skill`, so Orbit's defaults (`orbit-starter:story-manager`, `orbit-starter:story-engine`, `orbit-starter:review-pr`) are the right form.
- The Agent SDK runs a plugin agent as a session's main agent. `query({ prompt: 'say ok', options: { agent: 'orbit-starter:probe-agent' } })` applied the agent's system prompt (the probe replied with its own word instead of `ok`). The bare name `probe-agent` also resolved. An unknown name does not error: the session quietly runs as the default agent, so check the reply, not the exit status.
- `claude -p` exits 0 even when the turn failed. Read its output.

## Dependencies

`superpowers` lives in a different marketplace, so the manifest names it with its marketplace and the marketplace file allows that one cross-marketplace dependency:

```json
"dependencies": [{ "name": "superpowers", "marketplace": "claude-plugins-official" }]
```

```json
"allowCrossMarketplaceDependenciesOn": ["claude-plugins-official"]
```

A bare `"superpowers"` only resolves inside this marketplace and leaves the plugin failing to load.

## Try it in a clean config dir

Point `CLAUDE_CONFIG_DIR` at an empty directory so your own config is untouched. In Git Bash on Windows, use a Windows-style path for the variable. Git Bash on Windows also rewrites a leading-slash argument like `/agents` into a file path; run that command from PowerShell or cmd, or turn off Git Bash path conversion for it.

```sh
export CLAUDE_CONFIG_DIR=<empty temp dir>
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin marketplace add <path to this repo>
claude plugin install orbit-starter@orbit
claude plugin list
```

Installing copies the plugin into the config dir. After you edit a file under `starter/`, run `claude plugin uninstall orbit-starter@orbit` and install it again, because `claude plugin update` reports "already at the latest version" while the version string is unchanged.

To check the SDK, run the one-line `query` above from a script with `settingSources` left at its default and print the first assistant message.

## Checks

`test/starter.test.ts` reads every file under `agents/` and `skills/` and fails on a reference that does not resolve: an `orbit-starter:` name with no file behind it, a bare starter agent or skill name where a reference is expected, an `mcp__orbit__` tool Orbit does not serve, or a plugin prefix other than `orbit-starter` and `superpowers`. It also checks the `agent` of each lane in `examples/**/repo.json`.

```sh
node --disable-warning=ExperimentalWarning --test test/starter.test.ts
```
