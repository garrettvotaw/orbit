# PM domain file

`.claude/orbit/pm/<name>.md`, one per PM, committed. A project in Orbit's `config.json` names its file with
`domain`, relative to its folder. Orbit tells the `pm` agent which file is its own in the kickoff.

It holds what a PM needs to know that the code doesn't say. Five sections, in this order.

## Coordinates

Where the work lives: the tracker project, the area of the repo, the feature or epic to drive, and the board's
columns in order.

## Domain traps

Facts that have burned someone before. One bullet each, stated so a build lane can act on it. These go into
every briefing packet.

## Consult triggers

When to run each consult, by what the story looks like. A consult with no trigger here runs on the repo
profile's `consults` settings alone.

## On merge

The board column a story moves to when its PR merges. One word or phrase on a line of its own, e.g. `Done`.
The engine reads it as an exact column name.

## Reference branches

Branches worth knowing about besides the base branch: long-lived feature branches, release branches, and when
to target them.

See `examples/nx-web-api/.claude/orbit/pm/storefront.md` for a filled-in file.
