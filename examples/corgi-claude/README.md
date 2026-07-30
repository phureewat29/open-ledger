# Corgi Claude

An end-to-end agentic demo with OpenLedger: the `claude` CLI (Claude Code) works
through a synthetic, password-protected credit-card statement. Using only the
documented `oled` CLI surface, the agent:

1. **Discovers** the statement in the data directory
   (`oled ingest list` — it reports the file as encrypted).
2. **Prepares** it — the agent got the password in its prompt and passes it
   as `oled ingest prepare --password <password>`, which opens the PDF and
   extracts its text layer to a `document` text file, one page after another
   under `--- page N ---` markers.
3. **Reads** that document and extracts every transaction row, including
   refunds and the card-payment row (negative amounts become direction
   flips, never negative transactions).
4. **Commits** the extracted rows into the ledger
   (`oled ingest commit` / `done`), with idempotent row ids so a re-run
   never double-posts.
5. **Reports** back — the ledger's shape from `oled status`, period totals
   from `oled report --from … --to …`, account rollups from `oled accounts`,
   and the rows themselves from `oled transactions list`. Anything the agent
   says beyond that (top merchants, what to watch next month) it works out
   from those rows itself.

The agent may run only `oled`, read/write and search files, keep a todo list,
and use Claude Code Skills
(`--allowedTools "Bash(oled:*),Read,Write,Glob,Grep,TodoWrite,Skill"`).

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
  check the plumbing (build, statement placement, skill install, readiness,
  and that the statement is discovered and prepares into readable text).
  Useful when the `claude` CLI isn't installed/authenticated,
  or when iterating on the demo itself. Prints `PASS`/`FAIL` and exits 0/1.
- `npm start -- --keep-workspace` — don't delete the isolated workspace on
  exit; the run prints its path so you can poke around afterwards.
- `npm start -- --turn-timeout <seconds>` — kill a `claude -p` turn
  (SIGTERM, then SIGKILL 5s later if it's still alive) if it runs longer
  than this. Defaults to 900s (15 minutes).

Flags can be combined: `npm start -- --skip-claude --keep-workspace`.

For development, `npm run verify` typechecks the demo and then runs fast
offline checks of the `claude` stream parser, the answer markdown renderer, and
the plain reporter; it needs neither `claude` nor the OpenLedger build.

## What to expect

Output is flat, sequential plain text — the same whether stdout is a terminal
or a pipe (`npm start -- --skip-claude | cat`). While a turn runs with no other
output, a heartbeat line prints at most every 15s, so a long silent stretch
doesn't mean the demo has stalled.

Steps, in order:

1. **build OpenLedger** — `npm run build` at the repo root.
2. **create workspace** — a fresh, throwaway temp directory for this run,
   holding the `oled` bin shim (pointing at the freshly built
   `dist/cli/index.js`) and the isolation env described below.
3. **place statement** — copies `fixtures/card-statement-2026-05.pdf` into the
   workspace's data directory.
4. **install skill** — `oled setup --host claude` installs the skill pack
   where `claude` discovers it, and the run reports the path setup wrote.
5. **doctor readiness gate** — `oled doctor --json` must report `ok: true`
   (the db opens, the schema is present, the PDF reader loads) before the run
   hands off to `claude`. `oled status` is not a gate: it always exits 0.

With `--skip-claude`, two more steps run and then the run prints
`PASS`/`FAIL` and exits:

- **ingest list plumbing check** — `oled ingest list --json` reports at
  least one newly-discovered file awaiting ingest.
- **ingest prepare smoke** — `oled ingest prepare --password <password> --json`
  returns `kind: "text"` from `source: "text-layer"`, and the `document` it
  names is on disk with a `--- page 1 ---` marker. This is the contract every
  turn depends on, checked without spending a token.

Otherwise, a **check claude CLI** preflight step runs `claude --version`
first, so a missing/broken `claude` install fails immediately with a
friendly message instead of a raw `ENOENT` once the first turn tries to
spawn it.

The demo then runs a three-turn conversation in ONE continued `claude`
session (`claude -p`, then `claude -p --continue` twice — the agent keeps
its context across turns, exactly like everyday use). Each turn prints the
tool calls the agent makes (`> oled ...`, `> Read <path>`, `> Write <path>`,
`> Skill`) followed by its final answer:

1. *"ingest my new statements — the statement is password-protected; the
   password is: password — then give me a quick summary of what you found"*
2. *"resolve any open questions using your own judgment, and capture the
   card's statement metadata (masked number, points, due day) onto the
   account"*
3. *"how much did I spend this billed period, what were my top merchants,
   and what should I watch next month?"*

After the first turn the run reports whether the agent loaded the OpenLedger
skill; after every turn, how many `oled` commands it ran and a done/failed
summary line with duration. All of that is information, not a pass/fail check.
If a turn succeeds but writes to stderr, the run shows the last few lines
instead of discarding them silently.

After the three turns, a **final assertions** step re-checks
`oled status --json` (at least one file ingested, at least one transaction
recorded) and reports how many open questions are left — informational, since
the agent may legitimately defer some — then the run prints a final
`PASS`/`FAIL` line.

## The statement

`fixtures/card-statement-2026-05.pdf` is a synthetic credit-card statement from a
fictional bank ("Corgi Bank"), generated as demo data. It ships
**password-protected (AES-256)**; the password is `password`. OpenLedger never
stores PDF passwords: the caller keeps them and passes `--password` on each
`oled ingest prepare`. Here the demo hands the password to the agent in the
first turn's prompt, the same way a user would.

## Isolation

Every run builds a fresh, isolated workspace and redirects `HOME`/`USERPROFILE`,
`OLED_DIR`, `OLED_DB_PATH`, `OLED_DATA_DIR`, and `OLED_CACHE_DIR` into it before
doing anything else, so it never reads or writes your real `~/.oled` (if you have
one). `OLED_DB_ENCRYPTION_KEY` and the three `OLED_OCR_*` variables are blanked
too: the demo's database stays reproducible and no statement can be routed to an
OCR endpoint you happen to have exported.

The cache lives inside the agent's own working directory, so the documents it
reads never sit outside the workspace it was handed. The run deletes the
workspace on exit (including on Ctrl-C) unless you pass `--keep-workspace`.

## Build one yourself

Nothing in this demo's ~1,200 lines is sacred — the behavior is the point,
the code is one way to get it. Your own coding agent can build you an
equivalent. Paste these prompts into your agentic tool (Claude Code, or any
agent that writes and runs code) one at a time, from an empty directory; each
builds on the last. The result does not need to match this demo — keep the
checks, change anything else.

**1. An isolated harness**

    Create a runner script for a demo where an agent works a bank statement
    through the `oled` CLI (npm package `@aquartier/openledger`). The runner
    creates a throwaway workspace directory and runs every oled command with
    HOME, USERPROFILE, OLED_DIR, OLED_DB_PATH, OLED_DATA_DIR and
    OLED_CACHE_DIR redirected into it, and with OLED_DB_ENCRYPTION_KEY and
    every OLED_OCR_* variable set to the empty string — a run must never
    touch my real ~/.oled and never reach an OCR endpoint I happen to have
    exported. Delete the workspace on exit (including Ctrl-C); add a
    --keep-workspace flag that skips deletion and prints the path.

**2. A statement to work on**

    Place a statement PDF into the workspace's data directory under a bank
    subfolder, e.g. data/my-bank/statement.pdf. Use <path to a PDF you have>
    — a real statement is fine, everything stays local — or generate a
    synthetic one with realistic rows first. If it is password-protected,
    keep the password in a runner constant: oled never stores passwords, the
    caller passes one per run.

**3. Plumbing checks that cost no tokens**

    Add an offline mode (--skip-agent) that proves the plumbing without
    calling any model, one PASS/FAIL line per check, exit non-zero on the
    first failure: (a) `oled setup --host claude` (or --dir for another
    agent CLI) installs the OpenLedger skill and reports where; (b) `oled
    doctor --json` reports ok: true; (c) `oled ingest list --json` finds the
    statement — the summary line's `new` count is at least 1; (d) `oled
    ingest prepare <path> --password <pw> --json` returns kind "text" with a
    `document` file that exists on disk and contains a "--- page 1 ---"
    marker.

**4. The conversation**

    Now the live path. Run a three-turn conversation in ONE continued
    session of the agent CLI (for Claude Code: `claude -p`, then
    `claude -p --continue`), cwd'd into the workspace, tools restricted to
    the oled binary plus file read/write/search. Turn 1: "ingest my new
    statements — the statement is password-protected; the password is: <pw>
    — then give me a quick summary of what you found". Turn 2: "resolve any
    open questions using your own judgment, and capture the card's statement
    metadata onto the account". Turn 3: "how much did I spend this billed
    period, what were my top merchants, and what should I watch next
    month?". Print each turn's tool calls as one-line activity followed by
    its final answer, and kill a turn that exceeds a timeout.

**5. Prove it worked**

    After the turns, read `oled status --json` and assert files.ingested is
    at least 1 and counts.transactions is greater than 0; report
    questions.open as information (deferring some is legitimate). Print a
    final PASS/FAIL line with a matching exit code. Then run it: offline
    mode first, the live turns once offline passes.

Whatever shape your version takes, keep the contract these five steps pin
down: total isolation from the real environment, the caller holds the
password, plumbing proven before a token is spent, and a machine-checked
end state instead of trusting the transcript.
