# Corgi Claude

An end-to-end agentic demo with plasalid: the `claude` CLI (Claude Code) works
through a synthetic, password-protected credit-card statement. Using only the
documented `plasalid` CLI surface, the agent:

1. **Discovers** the statement in the data directory
   (`plasalid ingest list` — it reports the file as encrypted, with a vault
   password available).
2. **Prepares** it — the vault decrypts the PDF and returns a readable
   `document` path (`plasalid ingest prepare`).
3. **Reads** the statement PDF and extracts every transaction row, including
   refunds and the card-payment row (negative amounts become direction
   flips, never negative transactions).
4. **Commits** the extracted rows into the ledger
   (`plasalid ingest commit` / `done`), with idempotent row ids so a re-run
   never double-posts.
5. **Reports** back — spending by category, refunds, top merchants — from
   `plasalid status`, `plasalid report`, and `plasalid transactions list`.

The agent may run only `plasalid`, read/write files, and use Claude Code
Skills (`--allowedTools "Bash(plasalid:*),Read,Write,Skill"`).

## Prerequisites

- Node.js >= 18
- The `claude` CLI installed and authenticated (e.g. `claude auth login`),
  unless you only want the `--skip-claude` plumbing check

## Run it

```sh
cd examples/corgi-claude
npm install
npm start
```

Three flags change the run's behavior (pass them after `--` so npm forwards
them to the demo):

- `npm start -- --skip-claude` — skip the live `claude -p` turns and only
  check the plumbing (build, statement placement, skill install, vault
  unlock, and that `plasalid ingest list` discovers the statement). Useful
  when the `claude` CLI isn't installed/authenticated, or when iterating on
  the demo itself. Prints `PASS`/`FAIL` and exits 0/1.
- `npm start -- --keep-workspace` — don't delete the isolated workspace on
  exit; the run prints its path so you can poke around afterwards.
- `npm start -- --turn-timeout <seconds>` — kill a `claude -p` turn
  (SIGTERM, then SIGKILL 5s later if it's still alive) if it runs longer
  than this. Defaults to 900s (15 minutes).

Flags can be combined: `npm start -- --skip-claude --keep-workspace`.

For development, `npm run verify` runs a fast offline check of the
renderer's flicker-safety invariants — delta coalescing, the clock-driven
spinner, the bounded live-region line budget, the append-only scrollback, and
the answer markdown parser; it needs neither `claude` nor the plasalid build.

## What to expect

The demo reports the same information whether stdout is a terminal (a live
dashboard) or a pipe (flat sequential lines, e.g.
`npm start -- --skip-claude | cat`). In piped mode, a heartbeat line prints
at most every 15s while a turn runs with no other output, so a long silent
stretch doesn't mean the demo has stalled.

Steps, in order:

1. **build plasalid** — `npm run build` at the repo root.
2. **create workspace** — a fresh, throwaway temp directory for this run.
3. **write bin shim** — a `plasalid` shim script pointing at the freshly
   built `dist/cli/index.js`.
4. **export isolation env** — `PATH` (so the shim resolves), `HOME` /
   `USERPROFILE`, and the `PLASALID_*` variables described below.
5. **place statement** — copies `fixtures/card-statement-2026-05.pdf` into the
   workspace's data directory.
6. **install skill** — installs the plasalid skill pack so `claude` can
   discover the harness.
7. **vault add password** — stores the statement's password in the
   encrypted vault (piped over stdin, never as a command-line argument).
8. **status check** — confirms the harness is reachable before handing off
   to `claude`.

With `--skip-claude`, a final **ingest list plumbing check** step runs
`plasalid ingest list --json` and asserts at least one newly-discovered file
is awaiting ingest, then the run prints `PASS`/`FAIL` and exits.

Otherwise, a **check claude CLI** preflight step runs `claude --version`
first, so a missing/broken `claude` install fails immediately with a
friendly message instead of a raw `ENOENT` once the first turn tries to
spawn it.

The demo then runs a three-turn conversation in ONE continued `claude`
session (`claude -p`, then `claude -p --continue` twice — the agent keeps
its context across turns, exactly like everyday use). Each turn gets its
own panel showing the tool calls the agent makes (`> plasalid ...`,
`> Read <path>`, `> Write <path>`, `> Skill`) followed by its final answer:

1. *"ingest my new statements, then give me a quick summary of what you
   found"*
2. *"resolve any open questions using your own judgment, and capture the
   card's statement metadata (masked number, points, due day) onto the
   account"*
3. *"how much did I spend this billed period, what were my top merchants,
   and what should I watch next month?"*

After each turn, the run reports (for information only, not a pass/fail
check) whether the agent loaded the plasalid skill, how many `plasalid`
commands it ran, and a done/failed summary line with duration. If a turn
succeeds but writes to stderr, the run shows the last few lines instead of
discarding them silently.

After the three turns, a **final assertions** step re-checks
`plasalid status --json` (at least one file ingested, at least one transaction
recorded), reports the number of open questions left (informational — the
agent may defer some), and the run prints a final `PASS`/`FAIL` line.

## The statement

`fixtures/card-statement-2026-05.pdf` is a synthetic credit-card statement from a
fictional bank ("Corgi Bank"), generated as demo data. It ships
**password-protected (AES-256)**; the password is `password` and the demo
stores it in plasalid's encrypted vault, which is how the harness unlocks
statements without ever prompting.

## Isolation
The run never touches your real `~/.plasalid`. Every run builds a 
fresh, isolated workspace and redirects `HOME`/`USERPROFILE`,
`PLASALID_DIR`, `PLASALID_DB_PATH`, `PLASALID_DATA_DIR`, and 
`PLASALID_CACHE_DIR` into it before doing anything else — the run never 
reads or writes your real `~/.plasalid` installation (if you have one). 
The run deletes the workspace on exit (including on Ctrl-C) unless you pass
`--keep-workspace`.
