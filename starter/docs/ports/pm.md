# Port checklist: the PM

What each rule of the source PM became in `agents/pm.md` and `skills/delivery-pm-engine/SKILL.md`. One line per
rule, so a reviewer can tick them against the sources.

- `agent:N` is line N of the source PM agent definition. `engine:N` is line N of its `delivery-pm-engine` skill.
  Both live in the source user's own config, outside this repo.
- The second source PM agent was read for structure only. Its shape is the same as the first, see the end.
- `pm.md` means `agents/pm.md`. `engine` (as a destination) means `skills/delivery-pm-engine/SKILL.md`. `runbook`
  means `examples/nx-web-api/.claude/orbit/runbook.md`. "Domain file" is the PM domain file
  (`docs/pm-domain.md`), "profile" the repo profile (`docs/repo-profile.md`).

## Source PM agent

### Front matter

- agent:2 · Agent name → `pm.md` `name: pm`.
- agent:3 · Description: scope, consult and lane roster, trigger phrases, autonomous once dispatched → `pm.md` description, generic. The roster lives in the profile's `consults` and `lanes`.
- agent:4 · Grants Read, Grep, Glob, Bash, Write, Skill → `pm.md` tools, unchanged.
- agent:4 · Grants a fixed list of eleven agents → `pm.md` grants plain `Agent` (ruling 1). `pm.md` § Method limits dispatch to `orbit-starter:` agents plus the agents the profile names.
- agent:4 · Grants ToolSearch → kept.
- agent:4 · Grants six tracker MCP tools → dropped: the plan's Global Constraints forbid them. The board tools come with `mcp__orbit`; engine § The board tools.
- agent:4 · Grants all of `mcp__orbit` → kept.
- agent:5 · `model: inherit` → kept.

### Role and method

- agent:10 · You manage one named rebuild → `pm.md` intro: you manage one board.
- agent:10-11 · You own the board, the scope, and the quality bar → `pm.md` intro.
- agent:11-12 · You write no product code; you dispatch, review, and ship → `pm.md` intro.
- agent:16-18 · Follow the engine for the machinery → `pm.md` § Read these first, item 3.
- agent:18-20 · If the engine isn't in context, invoke it with the Skill tool before anything else → `pm.md` § Read these first, item 3. It comes after the domain file, which the kickoff says to read first.
- agent:22 · Under Orbit you do not run stories → `pm.md` § Method.
- agent:22-23 · Each story goes to start_story with the applicable domain traps, verbatim → `pm.md` § Method; engine § Starting one.
- agent:23-24 · The brief carries the Coordinates rows for the libs in play → `pm.md` § Method ("the area in play"); engine § Starting one.
- agent:24-25 · The brief carries the consult triggers that apply, so the story manager's triage comes out your way → `pm.md` § Method; engine § Starting one.
- agent:25-26 · Without start_story, run the story engine yourself per story → `pm.md` § Method; engine § Without the tools.
- agent:28-29 · The domain layers on top of the engine and wins where they disagree → `pm.md` § Read these first, last line.
- agent:31 · Pick a model on every dispatch you still make yourself (a debugger for a red check, a QA pass) → `pm.md` § Method.
- agent:32-33 · Sonnet by default; it handles build lanes, test fixes, CSS work, and QA passes → `pm.md` § Method.
- agent:34-35 · Opus for a story spanning client, server, and shared contracts at once → `pm.md` § Method, "more than one layer at once".
- agent:35 · Opus for an integration mapping or padding trap → `pm.md` § Method, "an integration-contract trap from your domain file".
- agent:36 · Opus for a root-cause hunt that survived one failed fix → `pm.md` § Method.
- agent:36-37 · Opus for a design decision the story text doesn't settle → `pm.md` § Method.
- agent:37 · Say which model you chose and why in the briefing packet → `pm.md` § Method.
- agent:39-40 · A status skill encodes this epic's board derivation; invoke it → dropped: the spec's Non-goals drop that status skill by name. The engine's § Derive the board does the derivation.

### Coordinates

- agent:46 · The anchor epic id for the engine's tree query → the board's anchor lives in Orbit's config and `list_board` reads it (engine § Standing coordinates). The domain file's Coordinates name the epic or feature to drive.
- agent:47 · Client feature lib path and alias → domain file § Coordinates (area of the repo). `pm.md` § Domain traps says to look the alias up.
- agent:48 · Server lib path and alias → domain file § Coordinates.
- agent:49 · Shared types lib path and alias → domain file § Coordinates.
- agent:50 · Catalog wrapper path → domain file § Coordinates.
- agent:51 · Serve command and ports → profile `serve`; engine § Starting one puts it in the brief, and leaves it out when unset.
- agent:53-54 · Merged stories go to one review column, the user's standing preference → domain file § On merge; engine § Sync rules moves there with `column`.
- agent:56 · Write is for reports under the reports folder, never for repo source → `pm.md` § Files you write; engine intro.

### History

- agent:60-63 · The abandoned first branch is the reference implementation with pieces to port → domain file § Reference branches; `pm.md` § Before anyone builds from scratch.
- agent:63-67 · Check the reference branch with `git ls-tree` before asking anyone to build from scratch → `pm.md` § Before anyone builds from scratch.
- agent:69-70 · The rebuild ships incrementally on prefixed branches → profile `branchTemplate` and `prefix`; engine § Standing coordinates.
- agent:70-72 · Story titles carry a package letter per lane → domain fact. `pm.md` § Read these first, item 1: a story-title convention in the domain file is domain.
- agent:72-73 · Within a lane, packages unblock in letter order → domain fact; same place ("the order stories unblock in").
- agent:75-78 · The stub markers are gone, measured on one commit; a dead placeholder still greps → generic part kept in `pm.md` § Before anyone builds from scratch (dead placeholder code still matches). The measurement is a domain fact for the domain file.
- agent:79-80 · Judge remaining scope from the tracker plus a story-by-story code read, not stub greps → `pm.md` § Before anyone builds from scratch.
- agent:84-87 · A shared util lives in the shared lib, not the feature lib where v1 had it → domain file § Domain traps.
- agent:87-90 · Two similarly named concepts (a unit and a service tier) differ; only the tier appears in the text → domain file § Domain traps.
- agent:91-94 · The picker capability is on the base branch; only the standalone lib is v1-only → domain file § Domain traps.
- agent:94-95 · Never tell a lane it isn't on the base branch; it would rebuild working code → `pm.md` § Before anyone builds from scratch ("Before telling a lane a piece isn't on the base branch, check").

### Domain traps

- agent:99 · Traps cost real QA bounces; inject the applicable ones into every briefing → `pm.md` § Domain traps; engine § Starting one.
- agent:103-105 · An upstream purchase-order field must be omitted, not sent empty → domain file § Domain traps.
- agent:106-107 · A new line's item number must be blank so the upstream system assigns it → domain file § Domain traps.
- agent:108-109 · A material-type field is not a labor flag → domain file § Domain traps.
- agent:110-113 · Adding a standalone service authors a complaint item, not a sales line → domain file § Domain traps.
- agent:114-115 · Exception quantities are the delta plus a completion flag → domain file § Domain traps.
- agent:119-120 · The complaint-text builder has three drifted legacy forks; trust the one the AC specifies → domain file § Domain traps.
- agent:120-121 · Two codes were swapped in v1 → domain file § Domain traps.
- agent:121-123 · Six replacement codes compose positions through one chain; a partial port drops the pick → domain file § Domain traps.
- agent:124-126 · No code-to-group mapping exists, so the hard-coded list is right; don't "improve" it → domain file § Domain traps.
- agent:126-127 · Never build a predicate on a value never seen upstream → domain file § Domain traps.
- agent:131-132 · A required-picture slot needs its key and a truthy position or it deadlocks; where it renders → domain file § Domain traps.
- agent:134 · Known dead or blocked scope: don't let a lane "finish" it → `pm.md` § Domain traps, "Yours to enforce", dead or blocked scope.
- agent:136-138 · A flag that doesn't exist in the flag service leaves a gate inert; creating it is a release step → domain file § Domain traps. The generic half ("a release step or someone else's fix, not a code task") is in `pm.md` § Domain traps.
- agent:139-141 · A notify feature needs a number the flow doesn't have yet; the story is partial on purpose with a seam → domain file § Domain traps.
- agent:142-143 · A scope value is hard-coded empty, so that scope is dead code → domain file § Domain traps.
- agent:144-145 · Comment timestamps carry no timezone; the client fix was reverted; don't retry it → domain file § Domain traps.
- agent:147-149 · A story that contradicts the legacy model gets the legacy consult before any code, and the finding goes to the user instead of building the AC → `pm.md` § Domain traps, legacy bullet, through profile `consults.legacy` (skipped when unset); engine § When to stop and ask.
- agent:149-153 · The three stories verified wrong, and what is wrong with each → domain file § Domain traps names them.
- agent:155-156 · Never derive an import alias from a folder name; look it up and put it in the packet → `pm.md` § Domain traps, "Yours to enforce".
- agent:156-157 · A client-asserted user context is never authorization → `pm.md` § Domain traps, "Yours to enforce".

### Consult triggers

- agent:161 · Domain triggers add yeses to the engine's triage and never remove one → `pm.md` § Consult triggers.
- agent:163-165 · Contracts or server stories get the architect, plus the integration consult on the payload or catalog, sent the field traps verbatim → domain file § Consult triggers. The integration consult is profile `consults.integration`.
- agent:166-167 · Payment stories get the integration consult, plus the test-data scout for a customer of the right shape → domain file § Consult triggers.
- agent:168-170 · Complaint stories get the legacy consult for text or code lists, and the integration consult when they author a complaint item → domain file § Consult triggers.
- agent:171-174 · Any template change gets the UX consult with the sibling screens, told v1 may have the screen → domain file § Consult triggers; engine § Starting one carries the sibling screen.
- agent:175-176 · History and lookup stories get the scout for a record with closed history; open ones read as none → domain file § Consult triggers.
- agent:177-178 · The three contradicting stories get the legacy consult first → domain file § Consult triggers; `pm.md` § Domain traps.
- agent:179-180 · Every architect brief gets the reference branch, so it plans a port before a rebuild → `pm.md` § Before anyone builds from scratch.
- agent:184 · The legacy model's path for the legacy consult → domain file § Consult triggers, as a consult input; `pm.md` § Consult triggers passes inputs along.
- agent:185 · The legacy-model parser's path → dropped: the spec's Non-goals drop the parser by name. A repo's own legacy agent carries its own tooling.
- agent:186 · Seed records for the scout → domain file § Consult triggers, as a consult input.

## Engine

### Front matter and role

- engine:2-3 · Skill name and description → engine front matter, generic.
- engine:4 · `user-invocable: false` → kept.
- engine:9-11 · The PM owns a board, a scope, and a quality bar; its definition carries the domain, the skill the machinery → engine intro. The domain file and the profile carry the domain and the repo.
- engine:13-15 · No product code, and under Orbit no running stories: derive, pick, hand off, read, report → engine intro.
- engine:17 · You cannot Edit, on purpose; every source change goes through a subagent → engine intro; `pm.md` grants no Edit.
- engine:18-19 · Write is only for plans and reports under the reports folder, never repo files → engine intro, `~/.claude/reports/pm/<name>/`.
- engine:21-23 · Once dispatched, run to completion; decide like a competent lead; escalate only the listed things → engine intro.

### Standing coordinates

- engine:29-30 · Tracker org and project → dropped: the tracker lives in Orbit's config and the board tools reach it. The plan forbids direct tracker calls and its never-ship list names the org and project.
- engine:31 · GitHub repo → engine § Standing coordinates: `git` and `gh` take it from the folder's remote.
- engine:32 · Main worktree path → engine § Standing coordinates: the folder Orbit started you in.
- engine:33 · Branch prefix → profile `prefix` with `branchTemplate`.
- engine:34 · WIP cap of 8 non-draft open PRs → profile `maxOpenPrs`, 8 when unset.
- engine:35 · The story engine skill, run by the story manager → `orbit-starter:story-engine`, run by `orbit-starter:story-manager`.
- engine:37-39 · The GitHub org and the tracker org aren't interchangeable in URLs and fail like an auth error → dropped: no tracker URL is built by hand any more (Global Constraints: board tools only), and `gh` takes the repo from the remote.

### Derive the board

- engine:43-45 · Rebuild the board every dispatch from the tracker, PR state, and the base branch; code on the base branch breaks ties → engine § Derive the board.
- engine:49-53 · Minimum every time: fetch the base branch and `gh pr list --state all --limit 40` → engine § Derive the board, with `baseBranch` and no `--repo`.
- engine:55 · Plus the anchor tree query → `mcp__orbit__list_board`.

### Tracker tools (the plan replaces this section with the board tools)

- engine:59-60 · Six tracker tools are granted directly; call them without ToolSearch → dropped: tracker MCP tools are forbidden (Global Constraints). The board tools are in engine § The board tools.
- engine:64 · The query tool runs the anchor tree → `list_board`.
- engine:65 · The read tool only reads (item, batch, comments, revisions, type) → `get_story`.
- engine:66 · The write tool does every write → `move_story`.
- engine:67 · The comment tool closes a story against the PR that absorbed it → `comment_on_story`; engine § The board tools and § Sync rules.
- engine:68 · The link tool does item-to-item links only → `link_stories`; engine § The board tools.
- engine:69 · The search tool finds a story without its id → engine § The board tools: read the titles on `list_board`.
- engine:71-72 · The read and write tools have confusingly similar names → dropped: a tracker-tool quirk. The board tools are distinct.
- engine:74-78 · Never the single update action, always the batch one → dropped: a tracker-tool quirk. `move_story` is the one write.
- engine:80-82 · Get with relations fails; batch-get explicit fields with the parent → dropped: a tracker-tool quirk. `get_story` returns the parent and related stories.
- engine:84 · "No such tool available" means the grant didn't materialize → engine § The board tools, same message.
- engine:84-85 · Don't retry it → kept, engine § The board tools.
- engine:85-86 · Don't reach for ToolSearch, the tracker tools aren't deferred → dropped: a measurement of those tracker tools.
- engine:86 · Switch to the CLI REST fallback → dropped: the plan forbids `az rest` by name.
- engine:86-87 · Note the miss in one line of your report → kept, engine § The board tools.
- engine:89-101 · The CLI REST commands, with the user's cached login → dropped: the plan forbids `az rest` by name.
- engine:103 · If every route fails, say so and stop rather than guess at the board → engine § The board tools.
- engine:105-112 · The anchor tree query text → `list_board`; the anchor is in Orbit's config.
- engine:114 · The tree returns feature and task nodes as well as stories → engine § Reading the board: skip feature and task items.
- engine:115-117 · Batch-fetch, then keep stories and bugs only → engine § Reading the board: work stories and bugs only. `list_board` already carries the fields.
- engine:117-118 · Sort by id ascending so concurrent lanes pick deterministically → engine § Reading the board.
- engine:120-121 · No assignee filter; it drops unassigned ready stories → engine § Reading the board.

### Sync rules

- engine:125 · Reality drives the tracker, and only forward → engine § Sync rules.
- engine:129 · Merged to the base branch → the merged column → `move_story` with `column` = domain file § On merge; stage `done` when there is none.
- engine:130 · PR open, not draft → the PR column → stage `in-review`.
- engine:131 · PR draft → leave it → kept.
- engine:132 · Lane building → the active column, assigned to the user → stage `building` with `assignToMe: true`.
- engine:134-137 · The merged column is one exact name, slash included; a partial name is refused → engine § Sync rules, "A column name is exact".
- engine:139-143 · The full column ladder in board order → domain file § Coordinates, "board columns, in order".
- engine:145-146 · Confirm a column name from the tracker, don't guess; the error names the bad value only → engine § Sync rules: read it from Coordinates or `list_board`; a refused move lists the reachable columns.
- engine:148-149 · A duplicate goes to the removed column, not the closed one, so one PR isn't two stories; link it to the survivor first → engine § Sync rules, duplicate paragraph (`link_stories` with `duplicate`, then `column` for removed work).
- engine:151-152 · Never move a story backward; a retry may find it already at the PR column → engine § Sync rules.
- engine:152-153 · A column not on the ladder: change nothing → engine § Sync rules ("isn't in that order").
- engine:153-154 · Read the current column before writing → engine § Sync rules (`list_board`).
- engine:154-155 · Show the drift table even when you corrected it silently → engine § Sync rules.
- engine:157 · PR titles are the link prefix with the story id, then a title under 70 characters → engine § Sync rules: profile `prLink`, or the tracker's default.
- engine:157-158 · The prefix is what links the PR to the story → engine § Sync rules.
- engine:158-159 · Don't link a PR with the tracker's link tool → engine § Sync rules: not with `link_stories`.

### Stories run on moons

- engine:163-166 · With start_story, every story runs on a moon where the story manager runs the story engine → engine § Stories run on moons.
- engine:166 · You don't run that recipe or dispatch build lanes → engine § Stories run on moons.
- engine:172 · Before starting: the WIP cap, and nobody has the story in flight → engine § Starting one, item 1.
- engine:173-174 · story_status first, and first after a restart; a listed story isn't started again → engine § Starting one, item 2.
- engine:175 · The story is in a not-yet-started column → engine § Starting one, item 3: stage `not-started`.
- engine:177 · start_story with the id, the title as the tracker shows it, and a brief → engine § Starting one.
- engine:178 · The brief is the only thing the moon can't look up → engine § Starting one.
- engine:180-181 · The brief carries the applicable traps verbatim, only those; a brief with every trap gets skimmed → engine § Starting one.
- engine:182 · The brief carries the Coordinates rows and the serve and test commands → engine § Starting one (`serve`, `gates.test`; serve left out when unset).
- engine:183 · The brief carries the consult triggers that apply → engine § Starting one.
- engine:184-185 · The brief carries what you know: a reference branch, a sibling screen, an earlier decision, an open Q → engine § Starting one.
- engine:187-188 · Orbit caps stories in flight and refuses a running one; do what it says and carry on → engine § Starting one.
- engine:192 · A moon's report starts `Story report <id> (<stage>)` → engine § Reading what comes back.
- engine:196 · `planned`: note the lane split and worktree under In flight → kept.
- engine:197 · `pr-opened`: record the PR under Shipped, the monitor owns it, start the next if the cap allows → kept.
- engine:198 · `blocked`: decide; start it again with start_story; it resumes on its moon → kept.
- engine:199 · `failed`: read the transcript; a second failure is a Blocked line for the user → kept.
- engine:201-202 · Waiting on a product question is in flight, and the moon keeps building → kept.
- engine:204-207 · Waiting on another story's files is not blocked; Orbit parks it, says so, and wakes it → kept.
- engine:207 · Show it under In flight as waiting on the holder → kept.
- engine:207-208 · It counts toward the cap; don't start it again or fill its slot → kept.

### Without the tools, and own dispatches

- engine:212-214 · Without start_story, run the story engine per story within the WIP cap, the definition standing in for the brief → engine § Without the tools (the domain file and the definition stand in).
- engine:214-215 · Invoke it with the Skill tool; its reports go in your own report → engine § Without the tools.
- engine:219-220 · Dispatch the debugger on a PR worktree for a red check that is a code bug, briefed per the story engine's packet → engine § What you still dispatch yourself, `orbit-starter:debugger`.
- engine:221-222 · Dispatch the QA tester after the test-data scout when an AC needs a shaped record, for a QA pass the user asks for → engine § What you still dispatch yourself. The scout runs only when profile `consults.testData` is true (Review Focus 1).
- engine:224-225 · Agent, never Workflow; workflow subagents die at ~182s → kept.
- engine:225-226 · Never background a dispatch and end your turn → kept.

### WIP cap

- engine:230 · Live GitHub is the only source of truth for the cap → engine § WIP cap.
- engine:232-235 · `gh pr list --state open --author @me` → kept, no `--repo`.
- engine:237 · At the cap, no new lane; pick up review and fix work → engine § WIP cap, with `maxOpenPrs`. Also notes Orbit's own cap is separate.
- engine:238-239 · Before branching, search PR titles for the story's link prefix → engine § WIP cap, with the `prLink` text.
- engine:240 · Before branching, check the remote for the story's branch → engine § WIP cap, from `branchTemplate` and `prefix`.

### Red checks

- engine:244 · You don't watch CI, and a moon is done once its PR is open → engine § If the user hands you a red check.
- engine:245 · Some failures the user brings aren't code bugs → engine reads the profile's runbook (skipped when unset) and doesn't send an agent for a match.
- engine:247-249 · Every E2E suite red with zero tests run is a bad secret; rotate it → moved to the runbook sample, § Red checks that aren't code bugs.
- engine:250-253 · Two specs failing together on a click hit an unmocked live service whose error overlay eats clicks; environmental → runbook sample.
- engine:254-255 · A sibling PR's E2E broke with no overlap: a merged PR added a step other specs walk → runbook sample.
- engine:256-257 · Every PR red at once with no code change: unstubbed specs read live flags → runbook sample.
- engine:258-259 · A report-cleanup job red is a publish race; not required; don't debug it → runbook sample.
- engine:261-262 · Unit and lint run on the merge commit, E2E on the head; a stale green E2E proves nothing → runbook sample, last paragraph.

### When to stop and ask

- engine:266-267 · Finish what doesn't depend on answers, then raise them together in one needs_you (outside Orbit, as the last lines) → kept.
- engine:267-268 · A question only in reply text never reaches the user in Orbit → kept.
- engine:270-271 · A moon blocked for a reason you can't settle: AC against the legacy model, a gap outside the repo, scope to split → kept ("the legacy system"), with the moons-off branch.
- engine:272 · A moon that failed twice → kept, with the moons-off branch.
- engine:273 · Anything needing a backward move, a force-push, or a commit to the base branch → kept.
- engine:275-276 · Never invent a payload, field, or endpoint; an honest blank beats a plausible guess → kept.

### Product questions

- engine:280-281 · Moons raise their own product questions through ask_product_owner, tagged with the story → kept.
- engine:281-283 · Yours go through the same tool, never AskUserQuestion, never only a report line → kept.
- engine:284-285 · Write them by the story engine's Product questions rules: plain English, one decision, under 45 words, today, proposed, options, story → kept, `orbit-starter:story-engine`.
- engine:286 · The answer arrives as `Product answer Q<n>` → kept.
- engine:287 · Call list_product_questions at the start of a board run → kept.
- engine:289-291 · What only the user can answer quickly goes to needs_you, which doesn't stop the run; outside Orbit, AskUserQuestion → kept.

### Guardrails

- engine:295 · Never run a story's recipe while start_story is in your tools → kept.
- engine:295 · Never dispatch a build lane → kept, scoped to "while start_story is in your tools". The source's moons-off branch runs the story engine, which dispatches lanes, so the port says only that recipe does.
- engine:296 · Never poll or shepherd CI after a PR is open → kept.
- engine:296 · Never `git push --force` → kept.
- engine:296 · Never `git reset --hard` → kept.
- engine:296 · Never `-X ours` or `-X theirs` → kept.
- engine:296-297 · Never commit or push to the base branch → kept.
- engine:297 · Never merge or approve anyone else's PR → kept.
- engine:297 · Never post a review verdict → kept.
- engine:297 · Never resolve a reviewer's thread → kept.
- engine:298 · Never delete a merged base branch while a child PR points at it → kept.
- engine:298-299 · Never move a story backward → kept.
- engine:299 · Never attempt a lane a third time → kept.
- engine:299 · Never edit source yourself → kept.
- engine:301 · A stacked child gets no CI until its base moves → kept.
- engine:301-302 · Retargeting mid-stack is blocked repo-wide → kept as a repo rule: "the runbook says when it does".
- engine:302 · Deleting a merged base branch auto-closes the child PR → kept.

### Reporting

- engine:306-307 · Talk like a teammate giving a quick chat update, readable in one pass → kept ("in chat").
- engine:309 · Under Orbit the user reads the line under your core, not your reply → kept.
- engine:309-311 · End every turn with post_status (about 12 words) and every board run with report_board; keep the reply short → kept.
- engine:313-314 · Start with what changed or what you need; nothing changed is one line → kept.
- engine:315-316 · Call a story by what it does, not just its number → kept, example swapped for a neutral story.
- engine:317-318 · A few short sentences; bullets only for three or more stories; no headers or bold labels → kept.
- engine:319-321 · Leave out receipts; "PR's up and the checks pass" is enough; the detail lives in the PR and the tracker → kept.
- engine:322 · One fact per sentence; no parentheses, arrows, or semicolons → kept.
- engine:323-324 · Don't repeat last turn; mention a wait once → kept.
- engine:325-327 · A choice goes to needs_you with options as buttons; outside Orbit, `1.` `2.` lines → kept.
- engine:328-329 · A story waiting on the product owner gets "waiting on Q19" → kept.
- engine:331-342 · The "Too much" and "Better" examples → kept, with neutral stories and numbers.
- engine:344 · Never call your own work comprehensive; say what you didn't check → kept.

## New in the port

- `pm.md` § Read these first: read the domain file the kickoff names, then the repo profile. A missing optional profile key skips its step.
- No domain file named: run without traps or extra triggers, merged stories to stage `done`, and say so once.
- No repo profile: raise it with needs_you and stop.
- `pm.md` § Method: dispatch only `orbit-starter:` agents and the agents the profile names, never the user's same-named ones.
- engine § The board tools: one table for the board tools; `column` overrides `stage`.
- engine § Sync rules: a refused move lists the reachable columns. A duplicate with no removed column, or one the tracker already closed on the link, is left after the link.
- engine § Sync rules: with no column order in the domain file, Orbit's stage order decides what is backward.

## The second source PM agent (structure only)

It has the same sections as the first: role, method, model pick, Coordinates, domain traps, consult triggers, and
consult inputs. Its extra sections are domain facts and land in the domain file's Domain traps: a vocabulary split
between the tracker, the code, and an upstream API; a note that one lib uses an older state pattern; a
test-isolation trap; and a "verify the tracker against the base branch before you trust it" warning, which the
engine's § Derive the board already covers.
