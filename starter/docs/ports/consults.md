# Port checklist: the consults

What each rule of the three sources became in the starter. One line per rule, so a reviewer can tick them against
the sources.

- `sa:N` is line N of the source story-analyzer agent. `ar:N` is line N of the source architect agent. `ux:N` is line
  N of the source ux-designer agent. All three live in the source user's own config, outside this repo.
- Destinations: `requirements.md`, `architect.md`, and `ux-designer.md` are `agents/`. `runbook` is
  `examples/nx-web-api/.claude/orbit/runbook.md`. "Profile" is the repo profile (`docs/repo-profile.md`).
- Rulings 1 to 4 are the controller's rulings for this task: keep each source's tools and `model: inherit` and add
  the Orbit tools, every consult stays read-only, keep every rule, people become "the user" and the company's end
  users become "the people who use the app".

## Source story-analyzer (to `requirements.md`)

### Front matter

- sa:2 · Agent name `story-analyzer` → `name: requirements`, per the plan's naming.
- sa:3 · Description: analyzes a story or bug, gathers linked items, descriptions, AC, repro steps, discussions, and attachments, produces a structured summary for planning → `requirements.md` description, same content, board-neutral.
- sa:4 · Grants Read, Grep, Glob → kept.
- sa:4 · Grants WebFetch, WebSearch → kept (ruling 1), now scoped in § Reading the story to non-tracker links.
- sa:5-6 · `mcpServers: ado` → dropped: the plan forbids tracker MCP servers. Replaced by the grants `mcp__orbit__get_story` and `mcp__orbit__get_attachment`.
- sa:7 · `model: inherit` → kept.

### Role

- sa:12 · Produces an implementation-ready summary from the work item → § Requirements intro.
- sa:12 · Gathers context only, never writes code or plans → § Requirements intro, and the description.

### Workflow

- sa:16 · Parse the work item ID or URL → § Workflow step 1 (also accepts a tracker key).
- sa:16 · Fetch it through the tracker MCP tools, scoped to one named project → § Reading the story and step 1: `get_story` only. The project is the board Orbit is configured for.
- sa:17 · Pull title, type, state, iteration, area path, assigned-to → step 2; a field `get_story` doesn't return is written as "not on the story".
- sa:18 · Collect all rich-text fields → step 3.
- sa:19 · Description and AC for stories → step 3.
- sa:20 · Repro steps and system info for bugs → step 3.
- sa:21 · Notes, history, and discussion comments → step 3.
- sa:22 · Attached images and files, summarize each → step 3, now through `get_attachment`.
- sa:23 · Traverse parent, child, and related links → step 4.
- sa:24 · Parent feature: read its description and AC → step 4 "Parent".
- sa:25 · Child tasks: list each with title, description, remaining work → step 4 "Children".
- sa:26 · Related stories and bugs: note title and status → step 4 "Related", and `get_story` on one when its AC decides this story.
- sa:27 · Scan the codebase for the files, components, services, modules the fields mention, noting paths and current implementations → step 5.
- sa:28 · Synthesize into the output format → step 6.

### Output format

- sa:32-71 · The markdown template (metadata, description, AC or repro, discussion, attachments, linked items table, relevant files, implementation notes) → § Output format, same sections. "Work Item" becomes "Story"; "Parent Feature" becomes "Parent".

### Guidelines

- sa:75 · Always traverse parent and child links, don't stop at the root → § Guidelines.
- sa:76 · Summarize discussion threads; verbatim quotes only for critical decisions → § Guidelines; adds who and when, because the story engine asks for them.
- sa:77 · For attached images, describe what they show → § Guidelines.
- sa:78 · If the item references files or components, search the codebase to confirm they exist → § Guidelines.

### Added for the story engine

- New · Return the AC verbatim, linked items with state, decisions, and what each attachment shows, and honor a length cap by trimming discussion and code notes first → last bullet of § Guidelines. The engine asks for "under 400 words".

## Source architect (to `architect.md`)

### Front matter

- ar:2 · Name `architect` → kept (agents are dispatched as `orbit-starter:architect`).
- ar:3 · Description: read-only architect for one named Nx monorepo, returns libs touched with aliases and project names, contract, lane split, reuse, boundary risks, open questions, use before multi-lib stories, never edits → `architect.md` description, repo name and "Nx" removed; "libs" becomes "packages".
- ar:4 · Grants Read, Grep, Glob, Bash → kept; adds `mcp__orbit__get_story` (ruling 1).
- ar:5 · `model: inherit` → kept.

### Role

- ar:10-12 · Turn a story into a plan generic frontend and backend workers can run in parallel without clobbering → § Architect intro.
- ar:11-12 · Reads code, writes a plan, never edits source, doesn't decide product scope → § Architect intro.
- ar:14-16 · The repo's CLAUDE.md files are the rules; read `libs/CLAUDE.md` every dispatch → intro paragraph: read the `CLAUDE.md` files for the packages in play every dispatch. The named paths become a read of the repo's own files. The profile and `runbook` are also read.

### Method

- ar:19-21 · Restate the AC as behaviors, one line each; ambiguous readings go to open questions → Method 1.
- ar:22-26 · Find what exists: grep the domain nouns, extend or copy a sibling, never plan a new abstraction when one exists → Method 2.
- ar:25-26 · A reference branch the brief names gets `git ls-tree` before planning from scratch → Method 2.
- ar:27-30 · Resolve every path to an alias and a project name, both differ from the folder → Method 3. The Nx commands become "the repo's workspace tool", with the Nx command as the example, and the alias lookup moves to the runbook's Packages and contracts section.
- ar:30 · Confirm the alias target directory exists, a few are dead → Method 3, and the runbook.
- ar:31-34 · Contract: interface in the shared type package, server DTO `implements` it with API decorators, client imports it → Method 4, as "the contract model the runbook describes"; the runbook states the `libs/<domain>/shared/type-*` model.
- ar:33-34 · Domain names, real boolean/number/Date, no upstream envelope, record numbers stay strings → Method 4 ("identifiers the repo keeps as strings"); the runbook's contract bullet.
- ar:34-35 · Model it on a named existing DTO → Method 4: "model it on the closest existing contract and cite it". The named file was a company path.
- ar:36-37 · A story touching an upstream payload with no integration finding: say the PM needs one before the server lane → Method 4.
- ar:38-41 · Lanes: contracts first, then server and client in parallel, disjoint file lists with specs, sequential when sharing a file, one lane if it is the whole story, no splitting for its own sake → Method 5.
- ar:42-46 · Flag silent risks: cross-domain import, shared importing a domain lib, a context provider injected without its module, new cross-lib import with no peerDep, a moved SCSS partial, `@Body()` typed as an interface, a feature flag key that may not exist; only the ones that apply → Method 6; the runbook states each with this repo's wording.
- ar:47-49 · Recommend a model per lane: `sonnet` ordinary, `opus` for client plus server plus shared, an upstream mapping, or a design the story doesn't settle → Method 7.

### What you return

- ar:53-54 · A plan the PM pastes into packets, needing no editing → § What you return intro.
- ar:56 · Behaviors → § What you return.
- ar:57-58 · Touches table: lib path, alias, project name, change, new or existing → § What you return.
- ar:58-59 · Contract with types and location, or "no contract change" → § What you return.
- ar:60 · Reuse with `file:line` → § What you return.
- ar:61-62 · Lanes: agent, model, owned files, depends-on, definition of done → § What you return; the agent names come from the profile's `lanes`, not fixed `angular`/`nestjs`.
- ar:63 · Risks, one line each, applicable only → § What you return.
- ar:64-65 · Open questions: AC ambiguities, contradictions with legacy for the legacy consult, outside blocks; empty is fine → § What you return; the legacy-analysis agent becomes "the legacy consult".

### Rules

- ar:69-70 · Never guess an alias, project name, or field name; grep it or mark it unknown → § Rules.
- ar:71-72 · Smallest change that satisfies the AC; a worthwhile refactor goes to open questions as a separate story → § Rules.
- ar:73 · A function over ~80 lines gets split; say where when a lane will touch one → § Rules.
- ar:74-75 · Use the team's vocabulary, don't coin names → § Rules; the named stack becomes "the frameworks, the upstream systems, and the domain nouns already in the code".
- ar:76 · Cite `file:line` for every claim about existing code → § Rules.

## Source ux-designer (to `ux-designer.md`)

### Front matter

- ux:2 · Name `ux-designer` → kept.
- ux:3 · Description: read-only designer for the named Angular apps, consulted before UI changes, returns a spec covering layout, a control per field, copy in the end user's vocabulary, states, keyboard, accessibility and locators, reuse, and legacy parity, never edits → `architect`-style rewrite in `ux-designer.md`: same list, the end-user word becomes "the people who use the app", the library and layout names become "the repo's grid" and "control", the legacy-app name becomes "legacy".
- ux:4 · Grants Read, Grep, Glob, Bash → kept; adds `mcp__orbit__get_story` (ruling 1).
- ux:5 · `model: inherit` → kept.

### Role

- ux:10-12 · Design for the people using the app inside screens that already exist; consistency beats novelty; reads code and writes a spec; never edits; doesn't widen scope → § UX designer intro. The named end users and the library-on-layout statement become the runbook's UI section, and "the people who use this app".

### Sources

- ux:14-17 · Read the design-system sources every dispatch → § Sources intro.
- ux:19-23 · The three named instruction files (building a component and the component-library traps, accessibility and styling rules, finding elements from a test) → § Sources: the profile and runbook UI section, the frontend `CLAUDE.md` and instruction files on components, traps, accessibility and styling, and the repo's rule for finding elements from a test.
- ux:22-24 · No `data-testid`; a control gets a real label, which both a screen reader and a test use → § Sources third bullet, and the runbook UI section.
- ux:27-30 · Sibling screens: match layout, spacing utilities, label placement, button order, empty and error treatment; cite `file:line` for each pattern → § Sources "The sibling screens".
- ux:31-32 · Shared component catalog; reuse before build → § Sources "The shared component catalog".
- ux:33-34 · Layout utilities source is the truth for what exists → § Sources "The layout system's utilities", now read from where the runbook names the layout system.
- ux:36-38 · A legacy rewrite with no legacy finding in the brief: say the PM needs one before the lane; you can't read the legacy model → § Sources closing paragraph; adds "where the runbook names no legacy app, parity doesn't apply".

### Method

- ux:42-43 · Restate the UI AC as observable behaviors; flag what two designers would build differently → Method 1.
- ux:44-45 · Locate the screen: component, template, siblings, the shared layout skeleton → Method 2.
- ux:46-47 · Reuse first, name the component with `file:line` → Method 3.
- ux:48-50 · Fill every section; copy and cite where siblings answer, decide and say so where they don't → Method 4.
- ux:51-53 · Walk the states: loading, empty, server error (global dialog or inline), disabled, validation, success → Method 5; "BFF error" becomes "server error", "the global error dialog" becomes "the app's global error handling".
- ux:54-55 · Walk the keyboard: tab order, Enter and Escape, focus after a dialog or added row → Method 6.
- ux:56-57 · Trap: change event fires per keystroke → Method 7 bullet 1, no component library named.
- ux:57-58 · Trap: combo box Escape writes `undefined` into a non-nullable control → Method 7 bullet 2.
- ux:58 · Trap: dialog inputs set through the dialog's input API → Method 7 bullet 3.
- ux:58-59 · Trap: a wrapped control breaks the label-association lint rule unless registered → Method 7 bullet 4.
- ux:59 · Trap: relative units only → Method 7 bullet 5.
- ux:60-61 · A label wrapping its control is associated without `for`; only a self-closing one beside the control needs `for` → Method 7 closing paragraph.
- ux:56-61 · Where the traps are named: the library-specific ones sit in the runbook's UI section as a marked example; the agent points to it.

### What you return

- ux:65 · A spec the lane builds without a design question → § What you return intro.
- ux:67 · Behaviors → § What you return.
- ux:68-69 · Layout on the grid, md and up, relative units only, no pixel widths → § What you return.
- ux:70-71 · Controls table: field, control, form-field and label wiring, format or mask, default, required → § What you return.
- ux:72-74 · Copy: every label, placeholder, button, empty-state line, and error message verbatim, in words already in the app, citing where the term appears → § What you return.
- ux:75 · States, one line each → § What you return.
- ux:76-77 · Interaction: tab order, Enter and Escape, focus, confirm before anything destructive → § What you return.
- ux:78-80 · Accessibility and locators: role and accessible name per interactive element, a visually hidden label where the caption shows elsewhere → § What you return.
- ux:81 · Reuse with `file:line` → § What you return.
- ux:82-83 · Legacy parity: preserve versus change on purpose, or "needs" the named legacy-analysis agent → § What you return; "needs the legacy consult".
- ux:84 · Open questions, only those that change the build → § What you return.

### Rules

- ux:88-89 · Match the sibling screen; deviation gets a one-line reason and the PM decides → § Rules.
- ux:90-91 · The named component library for controls, Bootstrap for layout; no new colors, spacing, or type sizes outside the theme; no component SCSS when a utility exists → § Rules, as "the component library" and "the layout system".
- ux:92-93 · Use vocabulary already in the app → § Rules.
- ux:94-95 · Design the AC, not the screen you wish existed; polish goes to open questions → § Rules.
- ux:96 · Cite `file:line` for every claim about existing UI → § Rules.

## Facts that moved out of the agents

- Nx alias resolution, the shared-contract model, the boundary rules, and the silent-failure risks → runbook "Packages and contracts".
- Component library, grid, who uses the app, finding elements from a test, the library traps, and legacy parity → runbook "UI", as a marked placeholder example.

## Rules not kept

None.

## What the story engine asks of each

- requirements: verbatim AC, linked and blocking items with state, decisions with who, when, what, and what each attachment shows, under 400 words → § Guidelines last bullet and § Output format.
- architect: Where (aliases and project names), Contract, Boundaries (the lane split) → § What you return Touches, Contract, Lanes.
- ux-designer: the UI spec pasted into the lane's packet → § What you return.
