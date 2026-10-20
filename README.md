# Orbit

A desktop home for a team of Claude Code agents. Each project gets a PM agent that owns its board, hands
stories to story agents of their own, and sees them through to an open pull request; a PR monitor watches
your open PRs and fixes what it can. Orbit is the window you run all of it from instead of a pile of
terminals: every lane is a globe on the home row, its agents orbit it, and anything that needs you lights up.

Electron + Angular, with the Claude Agent SDK in the main process.

**Status:** Windows today; macOS is in progress. Boards can live in Azure DevOps, Jira Cloud, or GitHub
Issues. GitHub is the only code host. Orbit runs the agents and skills you already have in `~/.claude`; a
generic starter set (a PM, a story agent, and the skills they use) is on the way.

## Quick start

You need Node 24, [Claude Code](https://claude.com/claude-code) signed in, and `gh` signed in. ADO boards
also need `az`. Orbit has been run on Bedrock; it starts sessions through the Agent SDK, which takes the same
API key or subscription sign-in Claude Code does, but those haven't been tried yet.

    npm install && npm --prefix src/renderer install
    npm run icons
    npm start            # builds main + renderer, opens the window
    npm test             # node --test on pure modules and the session host

Config lives at `~/.claude/orbit/config.json`. Everything else Orbit keeps (lane sessions, spend, product
questions, story agents, stars, the Jira sign-in) is in `~/.claude/orbit/orbit.db`, a SQLite file beside the
config; `npm run db:dump` prints it as JSON.

A minimal config with one PM and a PR monitor:

```json
{
  "projects": [
    {
      "id": "shop",
      "name": "Storefront",
      "agent": "shop-pm",
      "cwd": "~/src/storefront",
      "kickoff": "Run the board.",
      "tracker": { "kind": "github", "repo": "contoso/storefront", "project": 7 }
    }
  ],
  "monitors": [
    {
      "id": "prs",
      "name": "PR Monitor",
      "skill": "monitor-prs",
      "cwd": "~/src/storefront",
      "everyMinutes": 60,
      "stateFile": "~/.claude/reports/pr-shepherd/state.json"
    }
  ],
  "morning": ["shop", "prs"]
}
```

## Install

    npm run dist         # builds main + renderer, then release/Orbit-Setup-<version>.exe

Run the installer (it is unsigned, so SmartScreen will ask once). It installs to
`%LOCALAPPDATA%\Programs\Orbit`, adds **Orbit** to the Start Menu and Desktop, lives in the tray with the
orbit mark (amber when something needs you), and shows up in Apps & Features with an uninstaller. Config
stays at `~/.claude/orbit/config.json`, so a dev run and the installed app share lanes, which is why only one
Orbit may drive a config at a time: the second one explains and exits. `Orbit.exe --quit` shuts the running
one down; `--hidden` starts it in the tray.

### Dev shortcuts (running from source)

    npm run shortcut              # Desktop + Start Menu shortcuts to the dev build (no terminal window)
    npm run shortcut -- -Startup  # also start hidden in the tray at sign-in
    npm run shortcut -- -Remove   # delete all three

These point at `node_modules\electron\dist\electron.exe`. The dev shortcut runs the already-built app, so
`npm run build` after code changes.

## What it does

- **Home row and lanes.** Each project, monitor, and chat is a core on the home row, in config order. Click
  one and it moves to the focus spot: its agents list as satellites, its last board report runs along the
  bottom, and any satellite opens a transcript drawer built from the session files. **Morning start** brings
  up the lanes you list under `morning`; **End the day** winds them all down gently, and every lane can
  **Resume** after a relaunch.
- **New orbit** (top right) adds a lane without editing `config.json`: a *Project PM* (pick one of your
  agents, a folder, a kickoff) or a *Chat*, a plain Claude Code session that waits for you.
- **When a lane needs you** the core turns amber and says *your turn*, the beacon lights with its question and
  a button per choice it laid out, and the lane panel shows the same words with a composer for a free reply.
  Every lane gets an Orbit tool, `needs_you`, for exactly this, so a question never gets lost in reply text.
- **The board ring.** A project's core wears its board as a ring, one segment per column; in the lane view
  every story is a dot you can hover and click, and **Board** slides the columns in.
- **Story agents.** A PM hands each story to `start_story` with a brief, and Orbit starts a session of its own
  for it: a small moon circling the PM's core with the story number on its face and its own agents as specks.
  The moon claims the files it will touch (`claim_files`; two stories in flight never hold the same file)
  and reports back through `report_to_pm` at four points: planned, PR opened, blocked, failed. A claim another
  story holds parks the moon as *waiting*, and Orbit wakes it when the files free up. Moons run the agent
  named by `storyAgent` (default `story-manager`); `storyWipCap` (default 2) caps how many each PM has in
  flight; `storyMoons: false` turns the whole thing off.
- **Product questions.** PMs and moons get `ask_product_owner`. Orbit refuses anything a product owner
  couldn't read (developer words, code identifiers, field codes, long sentences, above about an 8th-grade
  level) and says how to rewrite it. Questions collect under **Decisions** with the PM's recommended choices
  as buttons; **Copy for PO** puts the open stack on the clipboard. `productTerms` in the config lists
  all-caps words your product owner does use, like your company's name.
- **PR monitor.** Orbit watches your open PRs itself (`gh pr list --author @me`, once a minute, no model
  involved) and wakes the monitor lane the moment something moves: CI red or green, new commits, a conflict,
  an approval, a comment, a PR opened or closed. The lane reads its skill's `state.json` for the PR ring and
  table.
- **Reviews** (top right) lists your team's open PRs across every project's repo, ranked by who was asked.
  **Review** starts a `/review-pr <n>` lane; you untick the comments to drop, pick a status, and Orbit posts
  the review to GitHub itself.
- **Galaxy.** Every PR merged on a PM's story becomes a star in a Milky Way behind the stage, in that PM's
  colour and its sprint. The sky resets each sprint, and last sprint's stars stay, dimmer, for one more.
- **Cost.** A core's caption is Claude Code's own session total, exact as of the last finished turn, with
  Orbit's estimate for the running one; the title strip's **today** sums every lane.
- **Memory guard.** Heavy test and build commands from every lane share two slots and queue for the rest;
  under 8 GB free the line drops to one, and under 3 GB nothing heavy starts and the beacon says what is
  using the memory. `testSlots`, `memoryHoldGb`, `memoryResumeGb`, and `memoryCriticalGb` tune it.
- **Screenshots** go to any lane from its composer: paste, drop, or pick up to five per message.
- **Per-lane model**, a **theme** that follows Windows, toasts, and a tray icon that breathes amber when
  something needs you. Everything honours `prefers-reduced-motion`.

## Trackers

A project's board can live in Azure DevOps, Jira Cloud, or GitHub Issues. The ring, the Board view, the
galaxy, and the sign-in card work the same on all three. Give a project a `tracker` block:

    { "kind": "ado", "org": "contoso", "project": "Storefront", "anchorId": 1200 }
    { "kind": "jira", "site": "contoso.atlassian.net", "projectKey": "ACME", "board": 42, "epic": "ACME-120" }
    { "kind": "jira", "site": "contoso.atlassian.net", "projectKey": "ACME", "board": 42, "jql": "labels = checkout" }
    { "kind": "github", "repo": "contoso/storefront", "project": 7, "iterationField": "Sprint" }
    { "kind": "github", "repo": "contoso/storefront", "label": "checkout" }

A project with no tracker runs its PM with no ring.

Every story has the tracker's own column and one of Orbit's stages: `not-started`, `building`, `in-review`,
`testing`, `done`, `blocked`. The ring keeps your column names. A column's stage comes from its name when it
plainly says (review, test, blocked), else from the tracker's category, and `"stages": { "Code Review":
"in-review" }` in the tracker block overrides either. Sprints come from ADO iterations, the Jira board, or the
GitHub Project's iteration field; a GitHub label board has three columns (open, PR open, closed) and no sprints.

Sign-ins: ADO uses `az`, GitHub uses `gh`, and Jira asks for your email and an API token on its sign-in card
the first time. That token is encrypted with the OS keychain and kept in `orbit.db`, never in `config.json`.

PMs can work in different repos: each project's repo comes from its folder's remote, or from a `githubRepo` on
the project, or from the top-level `githubRepo`. The galaxy, Reviews, and the PR watcher cover all of them.

Every PM and story agent whose project has a tracker gets four tools from Orbit: `list_board`, `get_story`,
`move_story` (to a stage; Orbit finds the column, and on Jira the transition), and `comment_on_story`. They
work the same on every tracker. Orbit writes to a tracker only when an agent calls one of them, and
`boardTools: false` in `config.json` hides them.

## Your agents

Orbit doesn't need special agents: any agent in `~/.claude/agents` or a project's `.claude/agents` can be a
PM, and every lane is told how Orbit hears it. What Orbit adds to each session, as tools on its own MCP
server: `needs_you`, `post_status`, and `withdraw_needs_you` for every lane; `report_board`, `start_story`,
`ask_product_owner`, and the board tools for PMs; `claim_files` and `report_to_pm` for story agents. Lanes
call you `userName` from the config, or the first part of your sign-in name.

## Tests

    npm test             # unit tests
    npm run e2e          # Playwright smoke against a fixture snapshot
    ORBIT_FIXTURE=e2e/fixture-snapshot.json npx electron .   # look at the UI without sessions

## License

MIT
