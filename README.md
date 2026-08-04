<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="OpenLedger" width="108">
  </picture>
</p>

<h1 align="center">OpenLedger</h1>

<p align="center">
  <strong>A reliable, deterministic ledger for your AI</strong>
</p>

<p align="center">
    OpenLedger is the harness that keeps your AI from hallucinating your money. It turns scattered bank and credit-card statements into a source of truth your AI can build any financial app on.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@aquartier/openledger"><img src="https://img.shields.io/npm/v/@aquartier/openledger.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@aquartier/openledger"><img src="https://img.shields.io/npm/dt/@aquartier/openledger.svg" alt="npm total downloads" /></a>
</p>

<br />

You've tried many personal finance apps from the App Store. None of them fits what you need, because each is someone else's idea of your money and lifestyle. So you asked AI to build the one that would, and it failed you too. It hallucinated the numbers, mangled your data, and never quite understood what you wanted.

AI fails when it has nowhere reliable to keep the numbers. OpenLedger gives it that place, a deterministic harness that holds every number in your own records.

OpenLedger is a secure bookkeeping harness for your AI. The source is what you already receive: monthly statements from your banks and credit cards. Your AI reads each statement and records what it finds as double-entry bookkeeping, so every posting balances, or it doesn't post.

Everything stays on your machine, and what the harness returns to your AI has PII redacted by default before it reaches your AI provider. No bank logins, no bank API keys, no cloud aggregator needed, just the bank documents you already have as the source of truth. It is your own private Plaid: scattered statements go in, a reliable ledger comes out, a data feed you own end to end.

The harness carries the bookkeeping, so the model doesn't have to be huge: the smallest model benchmarked, at 26B, runs a full statement through cleanly.

By using this harness, your AI can build the app you never found: a budget tracker that fits your lifestyle, a subscription auditor, a retirement planner, a personal money coach. Your finance app is now yours to reimagine.

## Use OpenLedger with your AI

The whole skill is one file: [`skills/SKILL.md`](./skills/SKILL.md).

### AI Apps
ChatGPT, Claude, Gemini

1. Install [Node.js](https://nodejs.org) (LTS), then paste into your terminal:

   ```bash
   npm install -g @aquartier/openledger
   ```

2. Paste into your AI chat:

   ```
   Fetch https://cdn.jsdelivr.net/npm/@aquartier/openledger/skills/SKILL.md
   and follow it. oled is installed; help me set up my ledger.
   ```

   If your chat app cannot fetch URLs, paste the skill itself: `oled setup --print | pbcopy` copies it; drop it into the first message or the app's custom instructions.

Your AI walks you through the rest.

### Coding Agents
Claude Code, Codex, Cursor, OpenCode, PI, OpenClaw

```bash
npm install -g @aquartier/openledger
npx skills add phureewat29/openledger
```

Or run `oled setup`, which writes the skill to `.agents/skills/`, the shared directory most agents read. Pass `--dir <path>` to name your agent's own skills directory instead, such as `--dir .claude/skills` for Claude Code.

### Use cases

1. Start with the statements you have waiting: *"Ingest my credit cards and bank statements."* It discovers new files, prepares and reads each one, commits the transactions it finds, and raises a question for anything it can't resolve on its own.
2. Clear whatever it flagged: *"Show me anything you weren't sure about, and let's resolve it."* It walks you through the questions the ingestion raised, such as an unrecognized merchant or an ambiguous account match.
3. With the ledger current, ask for the payoff: *"What's my net worth, and where did most of my spending go last month?"* Your AI reads the answer straight from the ledger.

## The Agent Workflow

Every row becomes a *transaction*: it debits one account and credits another by the same positive amount.

This is the loop the skill and `oled ingest --help` steer an agent through:

1. **Discover**: `oled ingest list --json` to find new/pending files.
2. **Prepare**: `oled ingest prepare <path>` registers the file and extracts it. A locked PDF exits 4 until the agent re-runs with `--password <password>`. A PDF carrying its own text layer, or a scan read by a configured OCR endpoint, comes back as a `document` text file. OCR is off until `oled config --ocr-url` sets it; with no text layer and no OCR endpoint, it comes back as one image per page.
3. **Read**: the agent reads what prepare returned, either the text document or the page images, and picks out every transaction row.
4. **Commit**: the agent pipes the transactions it extracted (one debit account, one credit account, one positive amount per row; splits go as a compound `linked` group) into `oled ingest commit`. The harness posts them into the ledger and raises a question for anything it can't resolve confidently (unknown merchant, a lookalike account, uncategorized fallback, cross-currency row).
5. **Resolve**: the agent (or you) works through `oled questions` for whatever got raised, then closes the file out with `oled ingest done <id>`.

## Commands

Run `oled --help` (or `oled <noun> --help`) for the full flag reference. Grouped overview:

```
oled                # Status: config, database, ledger counts, net worth (default)
oled doctor         # Diagnose the harness environment
oled setup          # Install the skill for an agent CLI (--dir <path>)
oled config         # Configuration

oled ingest         # Ingest pipeline: list / prepare / commit / done / fail
oled files          # Browse ingested files (list / show / drop)

oled transactions   # Transactions: list / show / add / update / delete / recategorize / dedupe / merge
oled accounts       # Manage the chart of accounts
oled merchants      # Manage merchants and their default accounts
oled questions      # List, answer, and defer open questions

oled report         # Income, expenses, and networth
oled notes          # Manage freeform notes
oled datasets       # Reference datasets: institutions for the US, Japan, Thailand, China

oled open           # Open the data folder in file explorer
```

## Security & Privacy

- All financial data stays on your machine; default `~/.oled/db.sqlite`. Both it and the config file are written with `0600` permissions.
- The config file (`~/.oled/config.json`) holds one secret at most, the OCR endpoint API key; `config show` surfaces a fingerprint of it, never the plaintext.
- Statement passwords are never stored. The caller keeps them and passes one per run with `--password`, a command-line argument, so it shows up in shell history and process listings.
- A decrypted statement stays in memory. Only what an agent has to read is written to `cache/`: the extracted text, or the page images.
- Read commands mask PII in free-text fields by default; `--no-redact` returns verbatim text.
- No telemetry, no analytics. OpenLedger makes no network calls of its own; OCR is the one exception, and it stays off until you set `--ocr-url`. Once set, `ingest prepare` sends page images to the endpoint to read, and `doctor` asks it which models it serves.

## Configuration

OpenLedger stores everything in `~/.oled/`. `oled config --init` creates it, along with the database and data directory:

```
~/.oled/
  config.json    # locale, currency, paths (0600 permissions)
  context.md     # persistent freeform context an agent can read (path shown as context_path in oled config show)
  db.sqlite      # SQLite database (0600 permissions)
  data/          # drop your statements here, as PDFs or images (subfolders allowed)
  cache/         # extracted text and page images handed to an agent
```

### Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `OLED_DIR` | Relocates `~/.oled`; other `OLED_*` vars still win for their own paths | `~/.oled` |
| `OLED_DB_PATH` | Database file path | `~/.oled/db.sqlite` |
| `OLED_DATA_DIR` | Statement drop folder | `~/.oled/data` |
| `OLED_CACHE_DIR` | Extracted text and page image cache | `~/.oled/cache` |
| `OLED_OCR_BASE_URL` | OCR endpoint base URL; OCR is off until this is set | unset (OCR off) |
| `OLED_OCR_MODEL` | OCR model id | `typhoon-ocr1.5` |
| `OLED_OCR_API_KEY` | OCR endpoint API key | unset |

See [`.env.example`](./.env.example) for defaults and full descriptions.

## Contributing

```bash
git clone https://github.com/phureewat29/openledger
cd openledger
npm install
npm run build
npm link # makes 'oled' available globally
```

## License

OpenLedger is licensed under the [Apache License 2.0](./LICENSE).
