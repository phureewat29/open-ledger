---
name: openledger
description: A local double-entry personal-finance harness driven through the `oled` cli. Use for anything about the ledger, bank or credit-card statements, net worth, spending, accounts, transactions, or merchants.
---

# OpenLedger

`oled` is a deterministic CLI over a local, double-entry ledger; you supply the intelligence. The CLI is the manual: `oled --help` lists the commands and the output contract, `oled <noun> --help` gives each command's behavior, flow, and flags, and every error carries a code and a message, often a `hint`. When you do not understand something, ask the CLI: never invent flags, subcommands, or ids.

Pass `--json` on every command; every stdout line is one JSON object, and list reads end with a `{"type":"summary"}` row (page with `--offset` += returned while it says `has_more`). With a shell, run `oled` yourself, one command per call. Human is your terminal: send one command per message, wait for the pasted output; ask for uploads instead of reading files.

## Setup

`oled --version` prints a version when installed. To install: check `node --version` >= 18, then `npm install -g @aquartier/openledger`. First run: `oled config --init --json` unless `oled status --json` shows `"configured":true`. Statements go in the `dataDir` from `oled config show --json`, as PDFs or as photos/scans (PNG/JPEG/WebP); `oled open` opens it.

## Commands

Start with `oled status --json`; descriptions live in `oled --help`. commands: `oled doctor --json` · `oled setup --force` · `oled config show --json` · `oled ingest list --json` · `oled files list --json` · `oled transactions list --json` · `oled accounts tree --json` · `oled merchants list --json` · `oled questions list --json` · `oled report --from <date> --to <date> --json` · `oled notes list --json` · `oled datasets --json` · `oled open`. A locked PDF exits 4: re-run `oled ingest prepare <path> --password <password> --json`. A long statement's rows outgrow a command line: write the NDJSON to a file and commit it with `oled ingest commit --input <file> --json`, one page at a time if that reads easier.
