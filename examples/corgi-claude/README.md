# Corgi Claude

An end-to-end agentic demo with OpenLedger: the `claude` CLI (Claude Code) works
through a synthetic, password-protected credit-card statement. Using only the
documented `oled` CLI surface, the agent:

1. **Discovers** the statement in the data directory
   (`oled ingest list` — it reports the file as encrypted, with a vault
   password available).
2. **Prepares** it — the vault decrypts the PDF and `oled ingest prepare`
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
  check the plumbing (build, statement placement, skill install, vault
  unlock, readiness, and that the statement is discovered and prepares into
  readable text). Useful when the `claude` CLI isn't installed/authenticated,
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

1. **build open-ledger** — `npm run build` at the repo root.
2. **create workspace** — a fresh, throwaway temp directory for this run,
   holding the `oled` bin shim (pointing at the freshly built
   `dist/cli/index.js`) and the isolation env described below.
3. **place statement** — copies `fixtures/card-statement-2026-05.pdf` into the
   workspace's data directory.
4. **install skill** — `oled setup --host claude` installs the skill pack
   where `claude` discovers it, and the run reports the path setup wrote.
5. **vault add password** — stores the statement's password in the
   encrypted vault (piped over stdin, never as a command-line argument).
6. **doctor readiness gate** — `oled doctor --json` must report `ok: true`
   (the db opens, the schema is present, the PDF reader loads) before the run
   hands off to `claude`. `oled status` is not a gate: it always exits 0.

With `--skip-claude`, two more steps run and then the run prints
`PASS`/`FAIL` and exits:

- **ingest list plumbing check** — `oled ingest list --json` reports at
  least one newly-discovered file awaiting ingest.
- **ingest prepare smoke** — `oled ingest prepare --json` returns
  `kind: "text"` from `source: "text-layer"`, and the `document` it names is
  on disk with a `--- page 1 ---` marker. This is the contract every turn
  depends on, checked without spending a token.

Otherwise, a **check claude CLI** preflight step runs `claude --version`
first, so a missing/broken `claude` install fails immediately with a
friendly message instead of a raw `ENOENT` once the first turn tries to
spawn it.

The demo then runs a three-turn conversation in ONE continued `claude`
session (`claude -p`, then `claude -p --continue` twice — the agent keeps
its context across turns, exactly like everyday use). Each turn prints the
tool calls the agent makes (`> oled ...`, `> Read <path>`, `> Write <path>`,
`> Skill`) followed by its final answer:

1. *"ingest my new statements, then give me a quick summary of what you
   found"*
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
**password-protected (AES-256)**; the password is `password` and the demo
stores it in OpenLedger's encrypted vault, which is how the harness unlocks
statements without ever prompting.

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
