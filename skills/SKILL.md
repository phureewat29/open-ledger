---
name: open-ledger
description: A local double-entry personal-finance harness driven through the `oled` CLI. Use for anything about the ledger, bank or credit-card statements, net worth, spending, accounts, transactions, or merchants — with or without a shell; without one, coach the human through the CLI one command at a time.
---

# OpenLedger

`oled` is a deterministic CLI over a local, encrypted, double-entry ledger; you supply the intelligence. The CLI is the manual: `oled --help` lists the commands and the output contract, `oled <noun> --help` gives each command's behavior, flow, and flags, and every error carries a `hint`. When you do not understand something, ask the CLI before guessing — never invent flags, subcommands, or ids.

Pass `--json` on every command. With a shell, run `oled` yourself, one command per call. Without one (chat app), the human is your terminal: send one command per message, wait for the pasted output; ask for uploads instead of reading files.

## Setup

`oled --version` prints a version when installed. To install: check `node --version` >= 18, then `npm install -g open-ledger`. First run: `oled config --generate-key --json` unless `oled status --json` shows `"configured":true`. Statement PDFs go in the `dataDir` from `oled config show --json`; `oled data` opens it.

## Commands

Start with `oled status --json`; descriptions live in `oled --help`. The nouns: `oled doctor --json` · `oled setup --force` · `oled config show --json` · `oled ingest list --json` · `oled files list --json` · `oled vault add <pattern> --password-stdin` · `oled transactions list --json` · `oled accounts tree --json` · `oled merchants list --json` · `oled questions list --json` · `oled report --from <date> --to <date> --json` · `oled notes list --json` · `oled datasets --json` · `oled data`.
