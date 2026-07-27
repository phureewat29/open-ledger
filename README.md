<p align="center">
  <img src="https://i.ibb.co/fdkHzmZk/plasalid-logo.png" alt="Plasalid" width="108" />
</p>

<h1 align="center">Plasalid</h1>

<p align="center">
  <strong>The Harness Layer for Personal Finance</strong>
</p>

<p align="center">
    A harness that turns scattered financial statements into a private, deterministic ledger for your AI.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/plasalid"><img src="https://img.shields.io/npm/v/plasalid.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/plasalid"><img src="https://img.shields.io/npm/dt/plasalid.svg" alt="npm total downloads" /></a>
</p>

<br />

You've tried many personal finance apps from the App Store. None of them fits what you need, because each is someone else's idea of your money and lifestyle. So you asked AI to build the one that would, and it failed you too. It halucinate the numbers, mangled your data, and never quite understood what you wanted.

AI fails when it has nowhere reliable to keep the numbers. Plasalid gives it that place, a deterministic harness that holds every number in your own records.

Plasalid is a secure ledger that serves as a harness for your AI. The data source is what you already receive which are monthly statements from your banks and credit cards. Your AI reads each statement and records what it finds as double-entry bookkeeping.

Everything stays on your machine, the database is fully encrypted, and what the harness returns to your AI has PII redacted by default before it sends to AI provider. No bank logins, no bank API keys, no cloud aggregator needed, just the bank documents you already have as the source of truth.

By using this harness, your AI can build the app you never found: a budget tracker that fits your lifestyle, a subscription auditor, a retirement planner, a personal money coach. Your finance app is yours to reimagine, and everything you build reads from the same ledger, so you can keep adding without starting over.

## Use Plasalid with your AI

The whole skill is one file: [`skills/SKILL.md`](./skills/SKILL.md). Every host gets the same bytes; `plasalid setup --print` prints them.

### AI Chat Apps (ChatGPT, Claude, Gemini, Kimi)

1. Install [Node.js](https://nodejs.org) (LTS), then paste into your terminal:

   ```bash
   npm install -g plasalid
   ```

2. Paste into your AI chat:

   ```
   Download https://raw.githubusercontent.com/phureewat29/plasalid/main/skills/SKILL.md
   and follow it as your instructions whenever I ask about my finances.
   I have plasalid installed. Set up my ledger with me: one command at a time,
   and I'll paste back the output.
   ```

Your AI walks you through the rest.

### Coding Agents (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, PI)

```bash
npm install -g plasalid
npx skills add phureewat29/plasalid
```

Or run `plasalid setup`, which writes the skill to `.agents/skills/`, the shared directory most agents read (use `--host claude` for Claude Code).

### Your own agent stack

Every command speaks `--json` with typed exit codes, built to be scripted. `plasalid setup --dir <agent-home>` installs the skill anywhere. Two complete references ship in this repo: [`examples/corgi-claude`](./examples/corgi-claude) runs the statement-to-answers loop with `claude -p`, and [`examples/corgi-eval`](./examples/corgi-eval) runs evals against any model and scores how well the harness fits.

With the skill installed, give your agent a real task:

1. Start with the statements you have waiting: *"Ingest my new statements."* It discovers new files, prepares and reads each one, commits the transactions it finds, and raises a question for anything it can't resolve on its own.
2. Clear whatever it flagged: *"Show me anything you weren't sure about, and let's resolve it."* It walks you through open questions, such as an unrecognized merchant or an ambiguous account match, one at a time.
3. With the ledger current, ask for the payoff: *"What's my net worth, and where did most of my spending go last month?"* It reads the answer straight from the ledger.

## The Agent Workflow

Every row becomes a *transaction*: it debits one account and credits another by the same positive amount.

This is the loop the skill teaches an agent to run:

1. **Discover**: `plasalid ingest list --json` to find new/pending files.
2. **Prepare**: `plasalid ingest prepare <path>` registers the file and returns its readable `document` path, unlocking encrypted PDFs via `plasalid vault`.
3. **Read**: the agent reads the statement PDF directly (modern agent models read PDFs natively; Plasalid stays deterministic).
4. **Commit**: the agent pipes the transactions it extracted (one debit account, one credit account, one positive amount per row; splits go as a compound `linked` group) into `plasalid ingest commit`. The harness posts them into the ledger and raises a question for anything it can't resolve confidently (unknown merchant, fuzzy account match, uncategorized fallback, cross-currency row).
5. **Resolve**: the agent (or you) works through `plasalid questions` for whatever got raised, then closes the file out with `plasalid ingest done <id>`.

## Commands

Run `plasalid --help` (or `plasalid <noun> --help`) for the full flag reference. Grouped overview:

```
plasalid                # Status: config, database, ledger counts, net worth (default)
plasalid doctor         # Diagnose the harness environment
plasalid setup          # Install the skill for an agent CLI (--host <id> | --dir <path>)
plasalid config         # Configuration

plasalid ingest         # Ingest pipeline: list / prepare / commit / done / fail
plasalid files          # Browse ingested files (list / show / drop)
plasalid vault          # Manage file-password patterns for encrypted statements

plasalid transactions   # Transactions: list / show / add / update / delete / recategorize / dedupe
plasalid accounts       # Manage the chart of accounts
plasalid merchants      # Manage merchants and their default accounts
plasalid questions      # List, answer, and defer open questions

plasalid report         # Income, expenses, and net
plasalid notes          # Manage freeform notes
plasalid datasets       # Reference datasets

plasalid data           # Open the data folder in file explorer (alias: open)
```

## Security & Privacy

- All financial data stays on your machine, encrypted with AES-256 (libsql); default `~/.plasalid/db.sqlite`.
- The config file (`~/.plasalid/config.json`) carries `0600` permissions; the only secret it holds is the database encryption key, and `config`/`status` surface only a fingerprint of it, never the plaintext.
- Encrypted-PDF passwords sit AES-GCM-encrypted in `db.sqlite` under a filename pattern; plaintext never touches disk.
- Read commands mask PII in free-text fields by default; `--no-redact` returns verbatim text.
- No telemetry, no analytics. Plasalid makes no network calls of its own.

## Configuration

Plasalid stores everything in `~/.plasalid/`:

```
~/.plasalid/
  config.json    # locale, currency, paths, encryption key fingerprint (0600 permissions)
  context.md     # persistent freeform context an agent can read (path shown as context_path in plasalid config show)
  db.sqlite      # encrypted SQLite database
  data/          # drop any PDFs here (subfolders allowed)
  cache/         # scratch space for rasterized/decrypted pages handed to an agent
```

### Environment variables

See `.env.example` for the current list:

```bash
# Relocates the entire ~/.plasalid directory, including config.json.
PLASALID_DIR=

# Passphrase used to encrypt the local SQLite database (AES-256).
# `plasalid config --generate-key` generates one if left blank.
PLASALID_DB_ENCRYPTION_KEY=

# Default: ~/.plasalid/db.sqlite
PLASALID_DB_PATH=

# Default: ~/.plasalid/data
PLASALID_DATA_DIR=

# Scratch space for decrypted/rasterized artifacts handed to external agent CLIs.
# Default: ~/.plasalid/cache
PLASALID_CACHE_DIR=
```

## Contributing

```bash
git clone https://github.com/phureewat29/plasalid
cd plasalid
npm install
npm run build
npm link # makes 'plasalid' available globally
```

`npm run integration` builds the CLI and runs a two-stage integration test against the built binary: a read-surface sweep (NDJSON validity, exit codes, zero ANSI) and a full write-path lifecycle in an isolated environment.

## License

Plasalid uses the [Apache License 2.0 with the Commons Clause](./LICENSE).

You're free to use, copy, modify, distribute, and fork it. The Commons Clause adds one restriction: **you may not Sell the Software**, meaning you may not provide a paid product or service whose value derives entirely or substantially from Plasalid's functionality (including paid hosting or support). For commercial-resale rights, contact the copyright holder to negotiate a separate license.
