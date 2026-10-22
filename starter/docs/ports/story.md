# Port checklist: the story machinery

What each rule of the five sources became in the starter. One line per rule, so a reviewer can tick them against
the sources.

- `sm:N` is line N of the source story-manager agent. `se:N` is line N of its story-engine skill. `acv:N` is line N
  of its ac-verify skill. `spin:N` is line N of its spinup skill, and `hook:N` line N of the copy-env script spinup
  bundles, which the source user's settings also run as a `PostToolUse` hook on `EnterWorktree`. All five live in
  the source user's own config, outside this repo.
- Destinations: `story-manager.md` and `ac-verifier.md` are `agents/`. `engine` is
  `skills/story-engine/SKILL.md`, `ac-verify` is `skills/ac-verify/SKILL.md`, `bootstrap` is
  `skills/worktree-bootstrap/SKILL.md`. `runbook` is `examples/nx-web-api/.claude/orbit/runbook.md`. "Profile" is
  the repo profile (`docs/repo-profile.md`).
- Rulings 1 to 5 are the controller's rulings for this task: plain `Agent` grant, ac-verifier as an agent,
  worktree-bootstrap instead of the hook, keep every rule, people become "the user" and named states become stages.

## Source story-manager agent

### Front matter

- sm:2 · Agent name → `story-manager.md` `name: story-manager`.
- sm:3 · Description: owns one story brief-to-PR on a moon, its steps, the consult roster, the four report stages, started by a PM through start_story and never by hand, autonomous → `story-manager.md` description, generic; the roster is the starter's consults plus the profile's integration and legacy agents.
- sm:4 · Grants Read, Grep, Glob, Bash, Write, Skill → kept.
- sm:4 · Grants a fixed list of eleven agents → plain `Agent` (ruling 1). `story-manager.md` § Method and engine § The team limit dispatch to `orbit-starter:` agents plus the agents the profile names.
- sm:4 · Grants ToolSearch → kept.
- sm:4 · Grants six tracker MCP tools → dropped: the plan's Global Constraints forbid them. The board tools come with `mcp__orbit`.
- sm:4 · Grants all of `mcp__orbit` → kept.
- sm:4 · No Edit in the grant → kept; the plan says the story manager keeps no Edit.
- sm:5 · `model: inherit` → kept.
- sm:6 · `color: cyan` → kept.

### Role, method, and never

- sm:11 · You own one story; a PM handed it over with a brief and went back to its board → `story-manager.md` intro.
- sm:11-12 · You take it from a fresh worktree to an open PR → intro.
- sm:12-13 · You tell the PM where it stands at four points: planned, pr-opened, blocked, failed → intro.
- sm:13-14 · Nothing else is yours: not the board, not other stories, not the PR after it opens → intro.
- sm:18-20 · Follow the story engine for everything (worktree, triage, packet, claims, lanes, gates, PR, moves, reports) → § Method, `orbit-starter:story-engine`.
- sm:20-21 · If the engine isn't in context, invoke it with the Skill tool before anything else → § Method.
- sm:23-24 · The first message is the PM's brief: traps, coordinates for the libs in play, what the PM knew → § Method ("the area in play").
- sm:25-26 · Treat the brief as the PM's own definition; it layers on the engine and wins → § Method.
- sm:26 · What the brief doesn't say, the consults find out; do not guess → § Method.
- sm:30 · Never run the board, pick another story, or start one → § What you never do.
- sm:31 · Never edit source; every change goes through the frontend, backend, or debugger agent → § What you never do: a build lane from the profile's `lanes` (or `orbit-starter:builder`), `orbit-starter:debugger`, or `orbit-starter:ac-verifier` during the AC gate, which now does the edits the source's `claude -p` child did.
- sm:32 · Never edit a file not claimed with claim_files → § What you never do ("let anyone edit"), since the story manager edits nothing itself.
- sm:33-34 · Never keep going after report_to_pm says finished; end the turn after pr-opened, blocked, or failed → kept.
- sm:35 · Never watch CI; the PR ends the story; the shepherd and monitor skills own it → kept, `orbit-starter:pr-shepherd` and `orbit-starter:monitor-prs`.
- sm:36-37 · Never ask the user in the transcript; product questions go to ask_product_owner; a call only the user can make goes in a blocked report → kept, with a pointer to the engine's needs_you rule (se:389-392).

## Source story engine

### Front matter and intro

- se:2 · Skill name → engine `name: story-engine`.
- se:3 · Description: the machinery, its steps, the consult roster, invoked by the story manager, run by a PM when the story tools are absent → engine description, generic.
- se:4 · `user-invocable: false` → kept.
- se:9-10 · You own one story, brief to PR, in a worktree of your own → engine intro.
- se:10-11 · You tell the PM where it stands at four points and no others → engine intro.
- se:11 · The PM only schedules; it doesn't run this recipe and you don't run its board → engine intro.
- se:13-15 · The brief carries the traps, the coordinates (repo, lib paths and aliases, serve and test commands), and what the PM knew → engine intro ("the area of the repo, paths and aliases").
- se:15-16 · The brief layers on top of the skill and wins where they disagree → engine intro.
- se:16-17 · Everything else you look up through the consults → engine intro.
- se:19-20 · You write no product code; you dispatch, review against real command output, and ship → engine intro.
- se:22 · You cannot Edit, on purpose; every source change goes through a subagent → engine intro.
- se:23-24 · Write is for consult results and notes under the stories reports folder, never repo files → engine intro, same path.
- se:26 · Run to completion without checking back → engine intro.
- se:26-28 · Decide like a competent lead; what you can't goes to the PM as blocked or to the product owner → engine intro.
- se:30 · Pick a model on every dispatch; sonnet by default → engine intro.
- se:31-32 · Opus for a story spanning client, server, and shared contracts at once → engine intro, "more than one layer plus shared contracts".
- se:32 · Opus for an upstream mapping or padding trap → engine intro, "an integration mapping or padding trap from the brief".
- se:32-33 · Opus for a root-cause hunt that survived one failed fix → engine intro.
- se:33 · Opus for a design decision the story doesn't settle → engine intro.
- se:34 · Say which model and why in the briefing packet → engine intro.

### Standing coordinates

- se:40 · Tracker org → dropped: the tracker lives in Orbit's config and the board tools reach it. The plan forbids direct tracker calls and its never-ship list names the org. Engine § Standing coordinates, Board row.
- se:41 · Tracker project → dropped, same reason. Board row.
- se:42 · GitHub repo → engine § Standing coordinates: `git` and `gh` take it from the folder's remote.
- se:43 · Main worktree path → the folder Orbit started you in.
- se:44 · Branch prefix → profile `prefix`, in `branchTemplate`.
- se:46 · Tracker writes go through the batch update action, even for one item → `mcp__orbit__move_story`. The batch quirk is dropped: it's a tracker-tool quirk, and `move_story` is the one write.
- se:47 · Tracker reads go through batch get with an explicit field list → `mcp__orbit__get_story` and `mcp__orbit__list_board`.
- se:48 · The two state names: active and pull request → stage `building` with `assignToMe`, and stage `in-review` (ruling 5; plan Task 4 notes). `stage` is always passed; a column the brief names goes in `column`.
- se:48-49 · The full ladder and every tracker quirk live in the PM engine; you need only those two moves → engine § Standing coordinates, `orbit-starter:delivery-pm-engine`.

### The team

- se:54 · You have no workers; you dispatch with the Agent tool → engine § The team.
- se:58 · Client paths go to the frontend agent → profile `lanes`, first glob match wins; the lane's agent.
- se:59 · Server paths go to the backend agent → profile `lanes`.
- se:60 · Shared types go to whichever side consumes them most → kept.
- se:61 · New end-to-end specs go to the lane that built the feature in the same dispatch: UI specs to the frontend lane, API specs to the backend lane → kept, "the screen's lane", "the endpoint's lane".
- se:62 · Failing unit tests, failing E2E, build and lint breaks, root-cause hunts → debugger → `orbit-starter:debugger`.
- se:63 · Stylesheet cleanup after UI work → the style-cleanup agent → that agent is dropped by the controller's name mapping (it isn't in the spec's What ships table). The row keeps the work and sends it to the lane that owns the stylesheet.
- se:64 · Smoke and QA testing → qa-tester, after test-data-scout when an AC needs a shaped record → `orbit-starter:qa-tester` after `orbit-starter:test-data-scout`.
- se:65 · Everything a builder would guess → the consults → kept.
- se:67-69 · Agent, never Workflow; workflow subagents die at ~182s and restart empty; Agent calls survive long gaps → kept.
- se:71-72 · Concurrent lanes own disjoint files; two agents on one spec clobber each other unseen → kept.
- se:72-74 · Within the story that's the architect's split; across stories it's claim_files → kept.
- se:76-77 · Dispatch independent lanes in one message so they run in parallel → kept.
- se:77-78 · Never background a lane and end your turn; a subagent's background child dies when it yields → kept.
- se:78 · Verify lanes by commit, not by report → kept.

### The briefing packet

- se:82-83 · Workers are generic; they know their frameworks, not your traps; every dispatch carries a packet → engine § The briefing packet ("they know their stack").
- se:85 · Items marked with a consult come from its result when triage called for it → kept.
- se:87-88 · 1 Story: id, title, verbatim AC, linked and blocking items (requirements consult) → kept, `orbit-starter:requirements`.
- se:89-90 · 2 Where: exact lib paths and their aliases from the tsconfig base file; never let a worker derive an alias from a folder name (architect) → kept, "as the repo defines them (a tsconfig `paths` map, a package's `name`)".
- se:91-92 · 3 Traps: copy the relevant brief entries verbatim, only those → kept.
- se:92-93 · A packet with every trap gets skimmed → kept.
- se:93-95 · The standing client and server traps live in the frontend and backend agent definitions and load as their system prompt; don't re-send them → kept generically ("that lane agent's own definition"). The named traps move with those agents and to the runbook (plan Task 6).
- se:96-97 · 4 Contract: the domain shape (architect), and the upstream field table when the lane sends or reads that payload → kept; the field table comes from the integration consult.
- se:97 · Otherwise the experience-layer rules → kept, "the repo's own contract rules".
- se:98-99 · 5 Definition of done: the exact gate commands, and "come back with the command output, not a claim" → kept.
- se:100-101 · 6 Boundaries: the lane's files, touch nothing else (architect's split) → kept.
- se:102-104 · 7 UI spec: a frontend lane changing a template or stylesheet gets the UX spec pasted, with "build to this spec; if it can't work, stop and say why" → kept, "a lane that changes a template or stylesheet".
- se:105-106 · 8 Test data: record ids with the predicate each meets (test-data scout) → kept.
- se:107-108 · 9 Consults: which ran, the path to each result, which were skipped and why → kept.
- se:110 · Tell workers to report file:line evidence → kept.
- se:110-111 · "Tests pass" without output proves nothing; re-dispatch asking for the run → kept.

### Consult before you build

- se:115-117 · Builders fill gaps by guessing; consults fill them first, so no builder makes a product, design, or upstream call → kept, "integration call".
- se:117-118 · All consults are read-only except the test-data scout, which can create data on dev → kept.
- se:118-119 · Consulting is the default; skipping one is a written decision → kept.
- se:121-122 · Consults don't edit, so they don't count toward the WIP cap or file ownership; several can run at once → kept.

### Triage every story

- se:126 · Answer every question for every story before its first build lane → kept.
- se:126-127 · A yes means that consult runs; put the answers in the planned report → kept, "when the profile has it".
- se:131 · Comments, attachments, or linked items (a comment count above zero, or any relation) → the requirements consult → kept. The story is read with `get_story`, which returns comments, attachments, parent, related stories, children, and links.
- se:132 · More than one lib, a contract change, or an unsettled design decision → architect → kept ("more than one package or area").
- se:133 · A template or stylesheet change beyond a one-line fix: new control, copy, state, or layout → UX designer → kept; the profile's `ux.when` also adds a yes.
- se:134 · A payload to the upstream system through its wrapper, or an upstream field the code doesn't read today → the integration consult → kept, run by the agent `consults.integration` names. The source's integration agent is dropped by the spec's Non-goals; its role is this slot.
- se:135 · A legacy screen or flow the AC doesn't spell out, or a story the brief lists as contradicting legacy → the legacy consult → kept, run by the agent `consults.legacy` names. The source's legacy agent is dropped by the spec's Non-goals; its role is this slot.
- se:136 · Specs or a later QA pass need a dev record with a particular shape → test-data scout → kept, `orbit-starter:test-data-scout`.
- se:138-139 · A one-file bug fix with a clear repro usually answers no to all six; say so in one line → kept.
- se:139-140 · The brief's domain triggers add yeses, never remove one → kept.

### Order

- se:144 · The requirements consult first, alone; the others read its AC → kept.
- se:145-147 · The rest in one message, in parallel → kept.
- se:148 · Reconcile, then dispatch build lanes → kept.
- se:150-151 · Point every consult at the story's worktree, not the main checkout → kept.
- se:153 · Sonnet for every consult → kept.
- se:153-154 · Opus for the architect when the story spans client, server, and shared, or triage had three or more yeses → kept.

### What to send each one

- se:158-159 · Keep briefs short; send only the facts a consult can't find → kept.
- se:161-163 · Requirements: the id; ask for verbatim AC, linked and blocking items with state, discussion decisions (who, when, what), what each attachment shows; under 400 words → kept.
- se:164-166 · Architect: id, title, verbatim AC, worktree, Coordinates rows, applicable traps, any reference branch → kept.
- se:167-169 · UX: the UI AC verbatim, worktree, route or component, the brief's sibling screens, the legacy finding on the legacy screen → kept.
- se:170-172 · Integration: the operation in plain words, the fields the AC implies, the applicable upstream traps verbatim, any rejection text → kept, example swapped for a neutral one.
- se:173-174 · Legacy: through the legacy-model reader skill, with the model path from the brief and one precise question → kept as "the inputs the brief names for it (a legacy model's path, a reference app) and one precise question". The reader skill is dropped: the spec's Non-goals drop the legacy-model parser by name, and a repo's own legacy agent carries its own tooling.
- se:175-176 · Test data: predicates as a list, the site if it matters, whether ids feed an E2E fixture or a QA pass → kept, neutral example, "site or tenant".
- se:177-179 · With nothing on dev of that shape, the scout builds the scenario; say so when QA needs a fresh record it will complete, void, or invoice → kept.

### Keep the results

- se:183-184 · Write each result under the story's consults folder as it comes back → kept, named for the consult without the plugin prefix (a colon can't go in a Windows file name).
- se:184-185 · On a retry or a second lane, reuse the file unless the AC changed → kept.
- se:185-186 · Packet item 9 carries the paths so a lane can read the whole result → kept.

### Reconcile before you dispatch

- se:190 · Consults can disagree; settle it before a builder sees it → kept.
- se:192-193 · File ownership comes from the architect's split; a file the UX spec names joins the lane that owns the screen → kept.
- se:194-195 · Upstream field names, formats, and absent-versus-empty come from the integration consult; domain names stay the architect's → kept.
- se:196 · Copy, labels, layout, and states come from the UX spec → kept.
- se:197-198 · Legacy behaviour comes from the legacy consult; if it contradicts the AC, the story goes to When to stop and no lane starts → kept.
- se:199-200 · Open questions that change the build do the same; others go in the PR body under what to watch → kept.
- se:201-202 · A test-data predicate nothing satisfies doesn't block; the lane mocks it; the gap goes in the planned report → kept.

### Check the lane against its consults

- se:206-208 · When a lane comes back, before the gates, read its diff against the UI spec, the upstream field table, and its owned files → kept.
- se:208-209 · Send a mismatch back to the same lane once, with the exact lines → kept.
- se:209-210 · Missing the spec a second time counts as a failed attempt → kept.

### Before a QA pass

- se:214-215 · Before the QA tester, run the test-data scout when an AC needs a shaped record, and put its ids in the tester's brief → kept, "and the profile turns the scout on".
- se:215-216 · A QA verdict BLOCKED on data with no scout run is a PM miss → kept.
- se:216-217 · So is one where the scout found nothing and wasn't asked to build it → kept.

### The story recipe

- se:221 · One story, in a worktree of its own, brief to PR → kept.
- se:223 · Worktree add with the user's branch prefix, story id, and slug, from the remote main → recipe step 1: `branchTemplate` filled with `prefix`, the id, and a slug, from `origin/<baseBranch>`.
- se:224 · A fresh worktree has no gitignored files and needs all three below → recipe step 1 runs `orbit-starter:worktree-bootstrap` on every new worktree (ruling 3).
- se:225 · Link the dependencies folder, never reinstall → bootstrap § Link and § Install (link it; skip an install that would write into a link). The path is profile `worktree.link`.
- se:226 · The Windows junction command with the main checkout's path → dropped: the never-ship list names both the command and the path. Bootstrap § Link makes the link with Node, on any platform.
- se:227-228 · Copy the server env file; without it every serve dies on a missing required variable → the file goes in profile `worktree.copy`. The symptom is in the runbook sample § Worktrees, and recipe step 1 says a skipped copy is the first suspect when a serve dies at startup.
- se:229-231 · Copy the E2E suite's login credentials `.env.local`; without it global setup retries three times and times out before a spec runs; they aren't in the server env file → bootstrap § Copy always copies every `.env.local`. The symptom is in the runbook sample § Worktrees.
- se:232 · Move the story to active only from the not-yet-started states → recipe step 2: `move_story` stage `building` only when `list_board` shows `not-started`.
- se:232-233 · Assign it to the user while moving it → `assignToMe: true`.
- se:233 · Anything else, leave it → kept.
- se:233 · Never move a story backward → kept.
- se:234-236 · Consult: triage, dispatch, reconcile; no lane until the consults it called for are back → recipe step 3.
- se:237-238 · Claim the files; a refusal parks the story until Orbit wakes it → recipe step 4.
- se:239-240 · Report planned with the lane split, consults, worktree, and branch; then build → recipe step 5, also passing `worktree` and `branch`.
- se:241 · TDD one AC at a time: failing test, red with the project's test command, implement, green, commit test and code together → recipe step 6: profile `gates.test` narrowed to the project or file.
- se:242-243 · Dispatch it to the frontend or backend lane with the packet; hold them to red-before-green → recipe step 6, "the lane's agent".
- se:244-245 · Check against the consults → recipe step 7.
- se:246 · Gates → recipe step 8.
- se:247 · Push and PR, titled with the tracker link prefix, the id, and the title → recipe step 9: profile `prLink`, or the tracker's default.
- se:247-249 · Body: what changed, why, what to watch, plus the AC evidence matrix file pasted as is → recipe step 9.
- se:250 · No unchecked `- [ ]` items, ever; omit a step that isn't done → recipe step 9.
- se:251 · Move the story to the pull-request state → recipe step 10: stage `in-review` (ruling 5), left alone if already there or later.
- se:252-253 · Report pr-opened with the PR number, URL, and two to five pasteable sentences → recipe step 11.
- se:254 · Opening the PR ends the story → recipe step 11.
- se:254-255 · Don't run `gh pr checks` or `gh run view`, read workflow logs, poll for shards, or dispatch a fix for a red check → recipe step 11.
- se:255-256 · CI shepherding belongs to the shepherd and monitor skills, which the user starts → recipe step 11, `orbit-starter:` names.
- se:256 · End your turn → recipe step 11.

### Claim the files

- se:260-261 · Two stories in flight never edit the same file; Orbit enforces it now → engine § Claim the files.
- se:261-263 · Once the split is back (or the files are known), claim every repo-relative path a lane will edit or create → kept.
- se:263 · Claim before any lane edits → kept.
- se:265-266 · On a refusal, don't edit around it and don't report blocked; Orbit parked the story and told the PM → kept.
- se:266 · End your turn → kept.
- se:267-268 · When the holder lets go, Orbit claims the files and says so; carry on → kept, same message text.
- se:268-271 · You keep held files while waiting, unless Orbit let go of them to break a loop; it claims them back on wake → kept.
- se:271 · A file a lane needs later gets claimed first; the same parking applies mid-build → kept.

### Reporting to the PM

- se:275-276 · report_to_pm is the only way the PM hears from you, at exactly these points → engine § Reporting to the PM.
- se:280 · planned: consults reconciled, files claimed, lanes about to start; carry the split, consults, worktree, branch → kept.
- se:281 · pr-opened: PR open and the tracker at the pull-request state; carry the PR, gates, what to watch → kept, "the board says `in-review`".
- se:282 · blocked: AC against legacy, a gap outside the repo; held files aren't blocked → kept.
- se:283 · failed: a lane failed twice or a gate won't go green; carry the evidence and the output path → kept.
- se:285-286 · Waiting on a product question isn't blocked: raise it, keep building, name the Q number next time → kept.
- se:288-289 · After pr-opened, blocked, or failed you are finished; end your turn → kept.
- se:289 · The PM's board report, not yours, is what the user reads → kept.

### Gates

- se:293 · No PR until every gate is green, with output you've seen → engine § Gates.
- se:296 · Affected test and lint against the remote main → profile `gates.test` and `gates.lint` (the nx-web-api example holds the same commands). Lint is skipped when the profile has none.
- se:297 · A whole-repo format check → profile `gates.format`, skipped when unset.
- se:298 · The AC gate as a `claude -p` child → dispatch `orbit-starter:ac-verifier` (ruling 2). The brief carries what the child got from its argument and its folder: the id, the worktree, the branch and base, the mode, the held files, and the report shape.
- se:298 · The Git Bash env var on that call → dropped: the never-ship list names the env var, and no leading-slash call remains. The general rule is kept (se:323-324).
- se:301 · Run the AC gate last, once test, lint, and format are green → kept.
- se:301-303 · It has its own fix loop: missing tests, failing AC, reruns, commits, up to three loops → kept.
- se:303 · Judge it by its JSON file, not its output → kept.
- se:305 · PASS: go; the `.md` beside it is the PR body's AC section → kept.
- se:306-307 · ESCALATED: a product question goes to ask_product_owner, anything else ends the story blocked → kept.
- se:308-309 · FAIL with no escalation, or an AC still PENDING: the run died; rerun once, then report failed → kept, "dispatch it once more".
- se:311-312 · It can create a spec beside a changed file; claim any `filesTouched` path you don't hold → kept.
- se:314-315 · The formatter is pinned and a newer global formats differently, so CI stays red; use the worktree's local install → engine § Gates, "Use the worktree's own tools". The pin itself is a repo fact in the runbook sample § Gate quirks, with no version (the never-ship list names prettier pins).
- se:316-318 · A local format check on Windows false-positives on line endings; trust the CI log; don't mass-rewrite → engine § Gates, "A local check can disagree with CI"; the specifics are in the runbook sample § Gate quirks.
- se:319-320 · Neither gate compiles component stylesheets; a broken relative import fails at app build; compile a moved partial by hand → engine § Gates, "Gates don't compile everything a build does"; the command is in the runbook sample § Gate quirks.
- se:321-322 · The `claude -p` child exits 0 on failure; judge by whether the work recorded itself → kept as "an agent that says it finished hasn't proved anything until the file says so". The child itself is gone (ruling 2).
- se:323-324 · Git Bash rewrites leading-slash args; prefix the env var, or shell out through Node with an args array → kept, with the env var described rather than named.
- se:325-326 · Unit green isn't boot green on server lanes; when a lane adds a service to a module, check the module's import by eye → kept generically; the specific module trap is in the runbook sample § Gate quirks.
- se:327-328 · Never put a story id in source, comments, JSDoc, tests, or templates; only branch, commit subject, PR title → kept.
- se:330-331 · Test, lint, or format failures go to the debugger with the raw output; it owns local unit, lint, and build failures → kept.
- se:331 · Two attempts per lane, then stop; no third → kept.
- se:332 · The AC gate's own loops don't count against that → kept.
- se:332-333 · Report the story failed and what the evidence says → kept.

### When to stop

- se:337-338 · Finish what doesn't depend on the answer, then report; these end the story blocked → engine § When to stop.
- se:340-341 · AC against the legacy model, or ambiguous enough for two codings, when it isn't a product question → kept, "the legacy system".
- se:342 · A consult's open question that changes the build and isn't a product question → kept.
- se:343-344 · Blocked outside the repo: a flag that doesn't exist in the flag service, an upstream field nobody fills, a missing endpoint → kept, "a feature flag that doesn't exist".
- se:345 · Anything needing a backward tracker move, a force-push, or a main commit → kept, "board", "base branch".
- se:346 · Scope that should split into a new story → kept.
- se:348 · A lane that failed twice ends the story failed → kept.
- se:350-351 · Never invent a payload, field, or endpoint; an honest blank beats a plausible guess → kept.

### Product questions go to the product owner, through Orbit

- se:355-357 · Some gaps aren't the user's: what the business wants when story and legacy disagree, which behaviour a given location should see, what a field means → kept; the store-and-site example becomes "a customer or a store".
- se:357-359 · Those are product questions; raise every one with ask_product_owner, never AskUserQuestion, never only a report line → kept.
- se:361-362 · The tool is non-blocking; Orbit shows the user, who answers or passes a stack to the product owner → kept.
- se:362-364 · Keep working; mention "waiting on Q<n>" in the next report → kept.
- se:364-365 · The answer arrives as a message starting `Product answer Q<n>`; act then → kept.
- se:365-366 · Call list_product_questions before asking; Orbit tags the question with the story → kept.
- se:368-369 · Write for the product owner, not a developer; Orbit refuses a bad question and says why; rewrite → kept.
- se:371-372 · Plain English, 8th-grade, short sentences, one decision, under 45 words, a question mark → kept.
- se:373-375 · No code words, identifiers, field codes, or system names; say what the person sees, types, or gets → kept; the field-code examples swapped for neutral ones.
- se:376-377 · `today`: what the legacy app does, one or two sentences; anchor there → kept.
- se:378 · `proposed`: one sentence → kept.
- se:379 · `options`: two to four, recommended first → kept.
- se:380 · `story`: filled in for you → kept.
- se:382-384 · The good example with today and options → kept, swapped for a returns example.
- se:386-387 · The bad example, a developer question hiding a product one → kept, swapped.
- se:389-390 · You have no AskUserQuestion; a technical or process call only the user can make goes to needs_you with one question and the choices → kept.
- se:390-391 · Keep working on what doesn't depend on it → kept.
- se:391-392 · If the story can't go on without it, also report blocked, naming the question → kept.

### Guardrails

- se:396 · Never run the board or start another story → engine § Guardrails.
- se:396 · Never poll or shepherd CI after the PR opens → kept.
- se:396 · Never `git push --force` → kept.
- se:396 · Never `git reset --hard` → kept.
- se:396 · Never `-X ours` or `-X theirs` → kept.
- se:396-397 · Never commit or push to main → kept, "the base branch".
- se:397 · Never merge or approve anyone else's PR → kept.
- se:397 · Never post a review verdict → kept.
- se:398 · Never resolve a reviewer's thread → kept.
- se:398 · Never delete a merged base branch while a child PR points at it → kept.
- se:399 · Never move a tracker story backward → kept, "on the board".
- se:399 · Never attempt a lane a third time → kept.
- se:399 · Never edit source yourself → kept.
- se:401 · A stacked child gets no CI until its base moves → kept.
- se:401-402 · Retargeting mid-stack is blocked repo-wide → kept as a repo rule: "the runbook says when it does".
- se:402 · Deleting a merged base branch auto-closes the child PR → kept.

## Source ac-verify skill

### Front matter and input

- acv:2 · Skill name → `ac-verify` `name: ac-verify`.
- acv:3 · Description: fetch AC, diff, prove each AC, fix and rerun for three loops, post the matrix to the PR, the tracker, and Orbit → ac-verify description, with `get_story`, `comment_on_story` and marker `ac-evidence`, and the profile's gates.
- acv:4 · `user-invocable: true` → kept.
- acv:7 · Gate the branch on every AC of its work item → ac-verify intro.
- acv:7 · A gate, not a report: an AC passes only with code and a test; a failing AC is fixed here → kept.
- acv:11 · No arguments: the id comes from the branch name → kept.
- acv:12 · `{id}`: use that id → kept.
- acv:16 · The tracker is for work items only → kept ("stories only"), reached only through `get_story` and `comment_on_story`.
- acv:17 · GitHub is for all git operations → kept.
- acv:18 · All the user's branches use one prefix → profile `branchTemplate` with `prefix`.
- acv:20 · It must run before any PR; when the user asks for a PR, run it first → kept.
- acv:20 · Go on to the PR only when every AC passes or the user explicitly accepts the gaps → kept.

### Mode

- acv:27 · `git branch --show-current` → kept.
- acv:32 · The user's own prefix → gate mode: tests, fixes, commits, push to an open PR, tracker comment, PR body edit → kept. "Yours" now means the brief says gate, or the branch fits the template with the prefix and any open PR on it is yours. A committed profile's prefix is shared by the team, so the prefix alone can't say whose branch it is.
- acv:33 · Anyone else's branch → report-only: steps 1 to 3 without tests or edits; no commits, comments, or PR edits → kept.
- acv:35 · Record the mode in the JSON → kept.
- acv:35 · Report-only still writes the JSON and the matrix and posts the Orbit status → kept.

### Step 0

- acv:41 · A numeric id in the arguments: use it → kept, any id form (`ACME-123` too).
- acv:42 · Otherwise the first run of digits after the user-alias prefix, with two examples → kept: the `{id}` slot of `branchTemplate`, or the first digits after the last `/` with no profile. The examples are swapped; one named a teammate's alias.
- acv:43 · Neither works: ask the exact question, stop, and wait → kept. Under the agent, where nobody can answer, it's written as ESCALATED with that question.

### Step 1

- acv:49 · Run 1a and 1b in parallel → kept.
- acv:53 · Get the work item from the tracker project → `mcp__orbit__get_story`.
- acv:53 · Pull the title, the type, and the AC field → kept.
- acv:53 · A bug with no AC uses its repro steps → kept; `get_story` returns repro steps.
- acv:55 · Split into one AC per testable behaviour, whatever the form → kept.
- acv:55 · Number them AC 1, AC 2 → kept.
- acv:57 · No AC: JSON with NO_AC and empty `acs`, the exact message, stop without blocking the PR → kept, "Story" for "Work item #".
- acv:61-65 · Base, first match: the open PR's base, the branch's parent in the stack registry, main → kept: the `orbit-starter:stack` skill's registry, then profile `baseBranch`.
- acv:67-72 · Fetch, merge-base, name-only diff, full diff → kept.
- acv:74 · A stacked branch's base is its parent, never main → kept.
- acv:74 · Unexpected files mean the base is wrong before they mean scope creep → kept.

### Step 2

- acv:80 · Write the JSON before analyzing, every AC PENDING → kept.
- acv:80 · Resolve `~` for the Write tool → kept.
- acv:80 · A rerun overwrites the file → kept.
- acv:82-99 · The JSON shape → kept. `workItem` is now `story`, a string, because ids can be keys. Example values are neutral.
- acv:101 · Top-level status runs PENDING, then PASS, FAIL, ESCALATED, or NO_AC → kept.
- acv:101 · The caller reads the file, not the transcript, so keep it current → kept.

### Step 3

- acv:107 · Work through the ACs in order → kept.
- acv:109 · Code: the file:line; read the whole file when the diff alone doesn't connect it → kept.
- acv:110 · Test: the file:line of a spec that exercises and asserts; a title alone or a locator matching nothing doesn't count → kept.
- acv:112 · Code but no test: write one in gate mode next to the code and run it with the project's test command → kept, profile `gates.test` narrowed.
- acv:112 · Follow the repo's test-rules file: no test ids, find by role, label, or text, no story ids → kept: follow the repo's written rules wherever they are; never a story id; role, label, or text over test ids where the repo says nothing.
- acv:112 · In report-only mode, note "code found, no test" → kept.
- acv:116-119 · PASS and FAIL definitions → kept.
- acv:121 · Never invent evidence; can't point at the line means FAIL with a note → kept.
- acv:121 · The point is catching gaps before QA → kept.
- acv:123 · Update the JSON after each AC → kept.

### Step 4

- acv:129 · Gate mode only → kept.
- acv:131 · Fix the implementation, or the test if the test is wrong → kept.
- acv:132-136 · Rerun affected test and lint against the merge base, and the format check on changed files with any line ending; read the output → kept: profile `gates.test` and `gates.lint` with `$MERGE_BASE` swapped in for a named base; `gates.format` on the changed files with `--end-of-line auto`. Unset gates are skipped.
- acv:137 · Commit the fix and its test together, imperative subject → kept.
- acv:137 · Check the branch first; never commit to main → kept, "the base branch".
- acv:138 · Re-verify every AC, not just the failures; bump `loop` → kept.
- acv:140 · Edit only files the branch changed, plus specs beside them → kept.
- acv:140 · Any other file is an escalation; under Orbit it may be another story's → kept.
- acv:140 · List every file edited or created in `filesTouched` → kept.
- acv:142 · Three loops at most; escalate when still FAIL after three, or when a fix needs a decision you can't make (the examples) → kept.
- acv:144 · ESCALATED with one precise question naming the AC, what was tried, and the unblocking choice → kept.
- acv:145 · End the output with the question; interactively, ask the user → kept.
- acv:147 · Don't loop on a red gate unrelated to the AC (flake, pre-existing lint); note it and keep going → kept.

### Step 5

- acv:153 · All pass: PASS, and the matrix goes to the `.md` → kept.
- acv:155-161 · The matrix format → kept, neutral paths.
- acv:165 · PR body: with an open PR, push the Step 4 commits, then replace or append the AC evidence section with `gh pr view` and `gh pr edit` → kept.
- acv:165 · No PR yet: the `.md` is the hand-off and the PR opener pastes it → kept.
- acv:166 · Comment the matrix on the work item as markdown → `mcp__orbit__comment_on_story` with marker `ac-evidence` (ruling 2).
- acv:166 · List comments first and update an earlier AC evidence comment rather than adding a second → kept through the marker, which edits Orbit's own earlier comment. Orbit can't edit a comment it didn't mark, so an older hand-posted one stays.
- ruling 2 · A reply saying the tracker dropped the marker still means the evidence posted; the next run posts a fresh one; not a failure → ac-verify § Step 5 and `ac-verifier.md` § How you work.
- acv:167 · Post one Orbit status line when post_status is available; otherwise make it the output's last line → kept, "evidence on the story".
- acv:169 · Report-only writes the `.md` and the Orbit line only → kept.
- acv:171 · FAIL or ESCALATED: skip the PR body and the tracker comment; the Orbit line names the failing AC → kept.

### Output

- acv:177 · Keep it short: the result, one line per AC, then any escalation → kept.
- acv:179-184 · The output format → kept; the dash and the `#` before the id are gone, since ids aren't always numbers.
- acv:186 · On a standalone run, stop there and don't create a PR → kept.

## Source spinup skill

- spin:2 · Skill name → its flow is `worktree-bootstrap`'s by-hand mode; the plan names the skill `worktree-bootstrap`.
- spin:3 · Description: spin up a worktree and work a task in this session → bootstrap description, "Run by hand with a task".
- spin:4 · `user-invocable: true` → kept on `worktree-bootstrap`.
- spin:11 · Make a worktree, set it up, then do the task yourself in this session there → bootstrap § By hand.
- spin:13 · The arguments are the task → bootstrap § Input.
- spin:18 · Derive a short kebab-case name from the task → kept, neutral example.
- spin:19 · The path is `../<repo-name>-<short-name>` → kept.
- spin:20 · The branch is the user's prefix plus the short name → profile `branchTemplate` with `prefix` and the short name as the slug; `<prefix>/<short-name>` with no story id.
- spin:25 · Worktree add from main → kept, `<baseBranch>`.
- spin:29-32 · Run the copy helper (server env, every `.env.local`, the license file) → bootstrap § Copy, by the hook rules below.
- spin:33-36 · Also copy root-level `.env*` files → bootstrap § Copy, always.
- spin:39-42 · Install dependencies in the new worktree → bootstrap § Install, profile `worktree.install`. Skipped when unset, or when it would write into a link.
- spin:45 · Do the task in the worktree, with its path as the base for every read, edit, and command; do the actual work → bootstrap § By hand, step 4.
- spin:48-52 · Report the path, branch, a summary, and the cleanup command → bootstrap § By hand, step 5. Cleanup now removes the links first (new, below).

## Source copy-env script (spinup's helper and the settings hook)

- hook:5-7 · Two modes: a worktree path argument, or the hook's stdin JSON → the skill takes the worktree path as its argument. The hook mode is replaced by ruling 3: the story engine runs the bootstrap after every worktree it makes. No plugin hook ships.
- settings · The hook fired after every `EnterWorktree` → replaced by ruling 3, same reason. A worktree made outside the story engine gets its copies when the user runs `orbit-starter:worktree-bootstrap` on it.
- hook:11 · Backslashes become forward slashes → bootstrap § Input, "use forward slashes in every path".
- hook:15 · The hook reads the worktree from the tool response's cwd → ruling 3, as above.
- hook:16-19 · No argument and no stdin: nothing to do → bootstrap § Input, "Nothing: nothing to do".
- hook:24-25 · The main checkout is the first entry of `git worktree list --porcelain` → bootstrap § Find the main checkout.
- hook:27-29 · The target is the main checkout itself: do nothing → kept.
- hook:31-37 · Copy the server env file when the source exists and the destination doesn't, creating its folder → bootstrap § Copy rules (missing: skip; present: leave; create parents). The path itself goes in profile `worktree.copy`.
- hook:39-55 · Find every `.env.local` in the main checkout, never descending into `node_modules` or `.git` → bootstrap § Copy, always; the skip rule also covers globs.
- hook:57-65 · Copy each to the same relative path when the destination doesn't exist, creating folders → kept.
- hook:67-72 · Copy the component library's license file at the root when present and absent from the worktree → the file goes in profile `worktree.copy`. Its name is a never-ship term.
- hook:73-75 · Ignore errors silently; the worktree may lack these files → bootstrap: a missing source is skipped quietly; any other failure is noted in one line and doesn't stop the run.

## New in the port

- engine § The repo profile: a missing optional key skips its step and the planned report says so. A missing profile ends the story `blocked`.
- engine § Standing coordinates: a board tool that's missing or refuses means skip that move and say so; a column the brief names goes in `column`, with the stage.
- engine § Consult before you build: the profile's `consults` says which consults the repo has; one it leaves off is "skipped: not in the profile". `ux.when` adds a yes.
- engine § The briefing packet, item 3: give the runbook's path instead of pasting it.
- engine § Reconcile: with no architect, the story manager splits the lanes from the profile's `lanes`.
- engine § The story recipe: with moons off, skip the claim and put the reports in your own report.
- engine § Gates: NO_AC from the AC gate means go, and the PR body says the story had no AC.
- `ac-verifier.md`: grants Read, Grep, Glob, Bash, Edit, `get_story`, and `comment_on_story` (ruling 2), plus Write (the skill writes its JSON, its `.md`, and new spec files, and Edit can't create a file), Skill with the skill preloaded, and `post_status` (the skill posts its Orbit line when the tool is there).
- `ac-verifier.md`: works only in the brief's worktree, can't claim files, does nothing past the gate, and carries
  the story engine's never-force-push and never-hard-reset guardrails.
- ac-verify § Step 1a: `get_story` missing or refusing means ESCALATED with the reply.
- ac-verify § Mode: with no repo profile, report-only unless the user says the branch is theirs.
- bootstrap § Link: Node makes the link on every platform; a junction is folders only, so a single file goes in `copy`.
- bootstrap § Install: skip an install that would write into a linked folder.
- bootstrap § Summary: one line, naming every skipped path.
- bootstrap § Read the profile: with no profile, copy the env files only.
- bootstrap § By hand: cleanup removes the links before `git worktree remove`, since a removal can delete through a link into the main checkout.
- runbook sample: § Gate quirks (the pinned formatter, the Windows line-ending false positive, uncompiled stylesheets, the boot-time module import) and § Worktrees (the missing env file, the E2E credentials file, the linked dependencies folder).
