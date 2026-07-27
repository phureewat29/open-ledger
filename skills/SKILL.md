---
name: open-ledger
description: A local double-entry personal-finance harness, via the CLI. Use for anything about the ledger, bank or credit-card statements, bank PDFs, net worth, spending, accounts, transactions, or merchants — or whenever the user names OpenLedger, asks to install it, or wants tracking set up from statement PDFs. Ingests, categorizes, and reports on it; installs the CLI from npm on first use.
---

# OpenLedger

You run `oled`, a deterministic CLI over a local double-entry ledger — no AI loop of its own; you supply the intelligence.

## Setup

- **Detect:** `oled --version` prints a version when installed; if it does, skip to Version check.
- **Install:** needs `node --version` >= 18; if missing, STOP and ask the human to install Node. Then `npm install -g open-ledger`. On EACCES: `npm install -g --prefix "$HOME/.npm-global" open-ledger`, then use `$HOME/.npm-global/bin/oled`.
- **First run:** skip when `oled status --json` shows `"configured":true`. Otherwise `oled config --generate-key --json` (creates ~/.oled), then `oled doctor --json`; every check must pass.
- **Statements in:** `dataDir` from `oled config show --json` is where PDFs go; `oled data` opens it. Sandboxed/VM: ask the human to upload there.
- **Version check:** compare `oled --version` with `npm view open-ledger version`; behind -> `npm install -g open-ledger@latest` (never downgrade), registry unreachable -> proceed. `oled <noun> --help` outranks this doc. `oled doctor --json` flags skill drift; `oled setup --force` refreshes it.

## Rules

- **Always pass `--json`.** NDJSON out: one object per line; streaming commands end with a `{"type":"summary",...}` line. Never scrape human tables.
- **Orient first:** `oled status --json` (config, database, ledger counts, net worth).
- **Never invent ids.** Account paths and `sf:` file / `tx:` transaction / `cn:` question / `m:` merchant ids come from the harness — find them with `accounts match`, `merchants resolve`, or a `list`.
- **The harness never prompts.** Destructive commands need `--yes`; passwords go through `--password-stdin` or the vault.
- **Branch on the exit code:** 0 ok · 1 error · 2 usage · 3 not-ready (see Setup, or `oled doctor --json`) · 4 input required (password / `--yes` — ask the human, retry) · 5 not-found (wrong id — `list`/`match`) · 6 invalid · 7 partial (batch partly failed — inspect each `result`).
- **Errors** are one stderr object `{"error":{"code":"E_...","message":...,"hint":...}}`. Always read `hint`.
- **Read output is PII-redacted by default:** `[USER]`/`[CARD]`/`[ACCT]`… are mask placeholders, not data; never write them back. Verbatim only when asked: `oled transactions list --no-redact --json`.
- **Statement rows go through `oled ingest commit --file <sf:id> --input <path>`, never `transactions add` per row.** Batch every row into ONE commit via `--input` — it links rows to the source file and keeps re-ingest idempotent. `transactions add` is only for one-offs with no source document.

## When you are blocked

Degrade in this order when your *environment* fights you — never silently break the rules above.

- **Cannot Read the PDF** (no PDF support): `oled ingest prepare <sf:id> --format png --dpi 200 --json` returns one PNG per page in `pages`; Read those (bundled rasterizer, no system deps).
- **File writes blocked** (cannot stage the `--input` batch): write it in the cwd first (usually allowed); if Write stays blocked, ASK the human to enable it. Last resort: commit rows one-by-one with `oled transactions add --resolve`, then TELL the user this drops idempotency + source-file linkage — a re-run double-posts.
- **One `oled` command per Bash call.** Never chain with `&&`/`;`/`echo`, never heredoc JSON (blocked by an allowlist + brace guard). Move batches via `--input <file>`.

## Core concepts

- **Every entry is a _transaction_:** debits exactly one account, credits exactly one, by one positive amount. Direction is WHICH account is debit vs credit — never a sign. Amounts are DECIMAL as printed (`135.00`); stored as integer minor units.
- **Normal balances:** `asset`/`expense` increase by a DEBIT; `liability`/`income`/`equity` by a CREDIT. Pick the two sides by which account each half grows.
- **Accounts** are colon-paths under `asset`, `liability`, `income`, `expense`, `equity` (e.g. `expense:food:groceries`). Reuse first: `oled accounts match --query <name> --json`. `accounts create` auto-creates missing parents (`created_parents` in output) — check `match` first to avoid near-duplicates. `--input <file>` batch-creates (NDJSON/JSON, same fields) for institution accounts.

### Direction

| Situation | Debit account | Credit account |
|---|---|---|
| Card purchase | `expense:<cat>` | `liability:credit_card:<x>` |
| Bank / debit-card spend | `expense:<cat>` | `asset:bank:<x>` |
| Bank fee | `expense:fees` | `asset:bank:<x>` |
| Cash purchase | `expense:<cat>` | `asset:cash` |
| Salary (net, simple) | `asset:bank:<x>` | `income:salary` |
| Interest earned | `asset:bank:<x>` | `income:interest` |
| Refund on card | `liability:credit_card:<x>` | `expense:<cat>` |
| Card payment (pay card from bank) | `liability:credit_card:<x>` | `asset:bank:<x>` |
| Cash withdrawal | `asset:cash` | `asset:bank:<x>` |
| Opening balance (asset) | `asset:<x>` | `equity:opening-balance` |
| Opening balance (card / liability) | `equity:opening-balance` | `liability:credit_card:<x>` |

- **Negative statement amounts mean money flowed BACK — never send a negative `amount`.** Use the matching table row at the absolute value (a `-165.00` card row is a refund; a large negative `Payment via <app>` row is the card payment). Card rows print two dates (transaction + posted) — use the TRANSACTION date.
- **Compound = shared-leg decomposition:** a split line becomes `linked` legs that commit atomically under one `group_id`. Find the ONE shared account; never invent clearing accounts. Payslip legs share `income:salary`; loan-payment legs share the paying `asset:bank:<x>`.
- **Idempotency (once, everywhere):** put `row_index` (0-based, per page) + `source_page` on every item and pass `--file <sf:id>`. The harness derives a stable id from file hash + page + row, so re-ingest is a `duplicate:true` no-op. Never renumber rows between retries.
- **Currency:** a transaction's two accounts must share one currency (derived from the accounts, never trusted from input). A cross-currency row drops as `currency_mismatch` — post it as two linked legs, one per currency, through `equity:conversion:<ccy>` (see the conversion-pair example).
- **Corrections:** wrong category -> `oled transactions recategorize`; wrong amount/currency -> `oled transactions delete` then re-ingest it. A refund is a forward transaction (see table), never an edit.
- **Account ids are HINTS:** each side resolves exact -> fuzzy (>= 0.7) -> placeholder — silent for a well-formed multi-segment hint, no question. An ambiguous hint (bare leaf, invalid type) falls back to `expense:uncategorized` and raises one. Send `raw_descriptor` + `merchant:{canonical_name, alias}` so aliases learn.

## Workflow: ingest statements

1. `oled ingest list --json` — each PDF's status (`new`/`pending`/`ingested`/`failed`), `file_id`, and whether it's encrypted.
2. `oled ingest prepare <pathOrId> --json` per new/pending file — `<pathOrId>` is the `path`/`rel_path` from `ingest list` or the `sf:` id (any cwd); returns `document`, the PDF to Read. Exit 4 = locked: ask for the password, then `printf '%s' "$PW" | oled ingest prepare <id> --password-stdin --json`; store it with `oled vault add <pattern> --password-stdin`.
3. **Read the `document` PDF** and extract every row. (No PDF support? See **When you are blocked**.)
4. Build one NDJSON item per row (schema below): set `row_index` + `source_page`; send `raw_descriptor` + `merchant`.
5. Stage the batch to a file, then `oled ingest commit --file <sf:id> --input <path> --json`. Each line is a `result`; the `summary` has `batch_id`, `posted`, `duplicates`, `failed`. Exit 7 = some rows failed (a `duplicate` is a successful no-op).
6. **Opening balances:** when the header implies an existing balance (prior card balance, account starting balance), POST it per the direction table (`equity:opening-balance`) then REPORT what you posted — do not ask first.
7. Card metadata from the header: `oled accounts update <liability:credit_card:x> --masked <digits> --points <n> --due-day <d> --statement-day <d> --json`. Stored form is `••` + last 4 significant digits (a full number truncates); echoed back in the result.
8. `oled questions list --batch <batch_id> --json` — resolve or defer (below).
9. `oled ingest done <sf:id> --agent claude-code --json` (failure: `oled ingest fail <sf:id> --error "<why>" --json`).

## Workflow: clear questions

`oled questions list --json`, then by `kind`:
- **similar_accounts** — near-duplicate; if the same: `oled accounts merge --from <id> --to <id> --yes --json`.
- **uncategorized** (placeholder created) — `oled transactions recategorize --set-account <id> --filter-account <placeholder> --json`, then `oled merchants set-default --merchant <id> --account <id> --json`.
- **unknown_merchant** — `oled merchants upsert --name <canonical> --alias <descriptor> --json`.
- **currency_mismatch** — re-post as a linked conversion pair.
- Answer: `oled questions answer <id> --answer "<text>" --json` (`--also <id,id>` closes siblings); `oled questions defer <id> --days <n> --json` when unknowable.
- Durable user preference/rule? `oled notes add --content "..." --category preference --json` (check `oled notes list --json` first).

## Other workflows

- **Manual entry** — a one-off the user dictates ("300 baht lunch, cash"), not statement rows: find ids with `oled accounts match --query <name> --json`, then `oled transactions add --debit-account expense:food --credit-account asset:cash --amount 300 --json`. `--resolve` fuzzy-resolves hint ids and raises questions, not failing.
- **Reporting** — net worth: `oled status --json` (`net_worth`); `oled report --from <date> --to <date> --json`; `oled accounts show <id> --json` and `oled accounts tree --json` (`balance`/`debits_posted`/`credits_posted`, rollups); `oled transactions list --json` (+ `show <tx:id> --json`; 50 rows default, 500 max via `--limit`, summary has `has_more`); `oled transactions dedupe --json`.
- **Cross-statement mirrors** — same payment on two statements: ingest both, find the pair with `oled transactions dedupe --json` (or `list --amount <decimal> [--currency <code>]`), then `oled transactions merge --from <tx:id> --to <tx:id> --yes --json` voids `--from` into `--to` (kept; idempotent re-ingest). Match amount, currency, and both accounts.
- **Source files** — inspect or drop the statement files backing the ledger: `oled files list --json`, `oled files show <sf:id> --json`, `oled files drop <sf:id> --yes --json` (cascades its transactions + questions).
- **Reference data** — the institution codes + country defaults behind account leaves: `oled datasets --json` lists the datasets; `oled datasets institutions --country th --kind bank --json` filters a country's institutions; `oled datasets defaults --json` gives per-country locale/currency.

## Ingest items

One standalone NDJSON item; a compound item swaps the top-level account/amount fields for a `linked:[...]` array sharing one group (payslip, loan, FX). Standalone requires: `date`, `description`, `debit_account`, `credit_account`, `amount` (> 0); account ids are HINTS. Full flags and subcommands: `oled <noun> --help`.

```json
{"date":"2025-03-14","description":"Starbucks Paragon","raw_descriptor":"POS 1234 STARBUCKS","source_page":2,"row_index":0,"merchant":{"canonical_name":"Starbucks","alias":"STARBUCKS"},"debit_account":"expense:food:coffee","credit_account":"asset:bank:kbank","amount":135.00,"currency":"THB"}
```

| field | type | req | notes |
|---|---|---|---|
| `date` | string | yes | ISO `YYYY-MM-DD`; Buddhist-Era year - 543. |
| `description` | string | yes | Human summary of the row. |
| `debit_account` | string | yes\* | Account to DEBIT; a HINT. Alias `debit_account_id`. |
| `credit_account` | string | yes\* | Account to CREDIT; a HINT. Alias `credit_account_id`. |
| `amount` | number | yes\* | Decimal as printed, > 0, in the accounts' currency; stored as minor units. |
| `linked` | array | no | Compound: omit top-level `debit_account`/`credit_account`/`amount`; legs are `{debit_account, credit_account, amount, description?, currency?, code?}`, committed atomically under one `group_id`. |
| `currency` | string | no | Hint only; default `THB`. Stored currency comes from the accounts; a differing hint is ignored (`transactions add --resolve` reports `currency_overridden`). |
| `code` | string | no | External reference, carried onto the transaction. |
| `raw_descriptor` | string | no | Verbatim bank text; feeds merchant-alias learning. |
| `source_page` | number | no | Page the row came from; part of the derived id, set whenever `row_index` is. |
| `row_index` | number | no | 0-based row position on the page; with `source_page` + `--file` makes re-ingest idempotent. |
| `source_file_id` | string | no | `sf:` id; falls back to `--file`, supplying the file hash for id derivation. |
| `merchant` | object | no | `{canonical_name (req), alias?, default_account_id?}`; upserted, alias learned. |
| `merchant_id` | string | no | Pre-resolved merchant id; overrides `merchant`. Unknown id raises `unknown_merchant`. |
| `id` | string | no | Explicit transaction id; ignored when a deterministic id can be derived. |
| `group_id` | string | no | Explicit compound group id; derived (`tg:`) from file hash + page + row when omitted. |

\* Required for a standalone item; supplied per-leg inside `linked`. Put shared fields (`date`, `description`, `raw_descriptor`, `source_page`, `row_index`, `merchant`) on the compound envelope, not the legs.

Compound / `linked` payslip (gross 60000 = net 50000 + tax 8000 + social security 2000, every leg crediting `income:salary`):

```json
{"date":"2025-01-25","description":"Acme payroll","source_page":1,"row_index":0,"linked":[{"debit_account":"asset:bank:kbank","credit_account":"income:salary","amount":50000.00,"description":"Net pay"},{"debit_account":"expense:tax","credit_account":"income:salary","amount":8000.00,"description":"Tax"},{"debit_account":"expense:social-security","credit_account":"income:salary","amount":2000.00,"description":"Social security"}]}
```

Cross-currency as a conversion pair (36000 THB out, 1000 USD in; each leg homogeneous, linked through `equity:conversion:<ccy>`):

```json
{"date":"2025-04-02","description":"THB to USD","source_page":3,"row_index":0,"linked":[{"debit_account":"equity:conversion:thb","credit_account":"asset:bank:kbank","amount":36000.00,"currency":"THB","description":"THB out"},{"debit_account":"asset:bank:wise-usd","credit_account":"equity:conversion:usd","amount":1000.00,"currency":"USD","description":"USD in"}]}
```

### Commit output

`oled ingest commit` emits one `result` per input item, then a terminal `summary`.

Standalone success:

```json
{"type":"result","index":0,"ok":true,"transaction_id":"tx:...","duplicate":false,"raised_questions":1,"merchant":{"how":"linked","merchant_id":"m:..."},"sides":[{"side":"debit","requested":"expense:food:coffee","resolved":"expense:food:coffee","how":"exact"},{"side":"credit","requested":"asset:bank:kbank","resolved":"asset:bank:kbank","how":"exact"}]}
```

Compound success — `group_id` + `legs` replace `transaction_id` + `sides`:

```json
{"type":"result","index":1,"ok":true,"group_id":"tg:...","legs":[{"transaction_id":"tx:...","duplicate":false}],"duplicate":false,"raised_questions":0,"merchant":{"how":"none"}}
```

Failure — the item drops, raising a question; `reason` is `dirty_input` or `currency_mismatch`:

```json
{"type":"result","index":2,"ok":false,"reason":"dirty_input","message":"...","raised_questions":1}
```

Summary — questions attach to the `batch_id`; exit 7 when `failed` > 0; duplicates are successes, counted separately:

```json
{"type":"summary","batch_id":"ib:...","posted":3,"duplicates":1,"failed":1,"raised_questions":2}
```

- side `how`: `exact` | `fuzzy_matched` | `placeholder_created` | `uncategorized_fallback` (`requested` = your hint, `resolved` = what posted).
- `merchant.how`: `none` | `unknown` (id missing) | `linked` (`merchant_id` present).
- `duplicate:true` means the transaction already existed (idempotent re-commit) — a success, never a failure.
- `raised_questions` counts the questions that item opened.

### Prepare output

`oled ingest prepare <pathOrId> --json` returns `document` (the PDF to Read) and one entry per page in `pages`:

```json
{"file_id":"sf:...","format":"pdf","document":"/abs/statement.pdf","page_count":3,"pages":[{"page":0,"path":"/abs/statement.pdf"}]}
```

The PNG fallback (`--format png --dpi 200`) sets `"format":"png"`, echoes `dpi`, and lists one PNG per page in `pages`.

## Taxonomy

Account roots + suggested subtypes — build colon-paths under each root:

- **asset** — bank, cash, wallet, prepaid_card, brokerage, crypto, receivable
- **liability** — credit_card, home_loan, auto_loan, personal_loan, student_loan, revolving, deferred_income
- **income** — salary, bonus, freelance, interest, dividend, refund, other
- **expense** — food, transport, utilities, rent, housing, healthcare, entertainment, shopping, subscriptions, education, travel, fees_and_interest, tax, insurance, other
- **equity** — opening-balance, conversion:<ccy> (opening balances and FX legs)

Institution codes and country defaults are data, not literals here: `oled datasets institutions --country <c> [--kind <k>] --json` lists a country's codes, `oled datasets defaults --json` its locale and currency. Use a code as the account leaf and bank field (asset:bank:kbank, liability:credit_card:ktc). Only banks, card issuers, wallets, brokers, and exchanges form accounts; insurers, telcos, and utilities are merchants, added with `merchants upsert`.
