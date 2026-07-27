import type { Command } from "commander";
import { emit, emitList, fail, mapNotFoundError, requireYes, runAction, type Column } from "../output.js";
import { openDb } from "../db.js";
import {
  listMerchants as queryMerchants,
  findMerchantByAlias,
  findMerchantById,
  upsertMerchant as upsertMerchantRow,
  setMerchantDefaultAccount,
  clearMerchantDefaultAccount,
  mergeMerchants as mergeMerchantRows,
  type MerchantRow,
  type MerchantUpsertInput,
} from "../../db/queries/merchants.js";
import { findAccountById } from "../../accounts/accounts.js";
import { applyRedaction } from "../../privacy/redactor.js";
import * as z from "zod";
import { parseInput, str, bool } from "../../lib/validate.js";

// `canonical_name` is the only free-text field; ids and the default-account
// link are structured data left verbatim.
const MERCHANT_REDACT_FIELDS = ["canonical_name"] as const;

const MERCHANT_COLUMNS: Column<MerchantRow & { alias_count: number }>[] = [
  { header: "ID", value: (m) => m.id },
  { header: "Name", value: (m) => m.canonical_name },
  { header: "Default Account", value: (m) => m.default_account_id ?? "" },
  { header: "Aliases", value: (m) => String(m.alias_count), align: "right" },
];

interface ListMerchantsOpts {
  redact?: boolean;
}

async function listMerchants(opts: ListMerchantsOpts): Promise<void> {
  const db = await openDb();
  const rows = applyRedaction(queryMerchants(db), !!opts.redact, MERCHANT_REDACT_FIELDS);
  emitList(rows, MERCHANT_COLUMNS);
}

const RESOLVE_MERCHANT_SPEC = z.object({ descriptor: str() });

async function resolveMerchant(opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(RESOLVE_MERCHANT_SPEC, opts);
  const db = await openDb();
  const match = findMerchantByAlias(db, parsed.descriptor);
  if (!match) {
    emit({ found: false });
    return;
  }
  emit({
    found: true,
    merchant_id: match.merchant.id,
    canonical_name: match.merchant.canonical_name,
    default_account_id: match.default_account_id,
  });
}

const UPSERT_MERCHANT_SPEC = z.object({
  name: str(),
  alias: str().optional(),
  default_account: str().optional(),
});

async function upsertMerchant(opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(UPSERT_MERCHANT_SPEC, opts);
  const db = await openDb();
  if (parsed.default_account && !findAccountById(db, parsed.default_account)) {
    fail("NOT_FOUND", `account "${parsed.default_account}" not found`);
  }
  const input: MerchantUpsertInput = { canonical_name: parsed.name };
  if (parsed.alias) input.alias = parsed.alias;
  if (parsed.default_account) input.default_account_id = parsed.default_account;
  const merchant = upsertMerchantRow(db, input);
  emit(merchant);
}

const SET_DEFAULT_SPEC = z.object({
  merchant: str(),
  account: str().optional(),
  clear: bool().optional(),
});

async function setMerchantDefault(opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(SET_DEFAULT_SPEC, opts);
  if (!!parsed.account === !!parsed.clear) {
    fail("USAGE", "exactly one of --account or --clear is required");
  }

  const db = await openDb();
  if (!findMerchantById(db, parsed.merchant)) {
    fail("NOT_FOUND", `merchant "${parsed.merchant}" not found`);
  }

  if (parsed.clear) {
    const result = clearMerchantDefaultAccount(db, parsed.merchant);
    if (!result) fail("NOT_FOUND", `merchant "${parsed.merchant}" not found`);
    emit({ merchant_id: parsed.merchant, before: result.before, after: null });
    return;
  }

  if (!findAccountById(db, parsed.account!)) {
    fail("NOT_FOUND", `account "${parsed.account}" not found`);
  }
  const result = setMerchantDefaultAccount(db, parsed.merchant, parsed.account!);
  emit({ merchant_id: parsed.merchant, ...result });
}

const MERGE_MERCHANTS_SPEC = z.object({
  from: str(),
  to: str(),
});

interface MergeMerchantsOpts {
  from?: string;
  to?: string;
  yes?: boolean;
}

async function mergeMerchants(opts: MergeMerchantsOpts): Promise<void> {
  const parsed = parseInput(MERGE_MERCHANTS_SPEC, opts as Record<string, unknown>);
  requireYes(opts, "merging merchants");
  const db = await openDb();
  let result;
  try {
    result = mergeMerchantRows(db, parsed.from, parsed.to);
  } catch (err) {
    mapNotFoundError(err);
  }
  emit({ from: parsed.from, to: parsed.to, ...result });
}

export function registerMerchants(program: Command): void {
  const merchants = program
    .command("merchants")
    .description("Manage merchants and their default accounts")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: manages merchants and their default accounts; an alias maps raw bank text to a merchant.",
        "Typical flow: resolve a descriptor; if unknown, upsert with a name and alias, then set-default.",
        "Example: oled merchants resolve --descriptor \"POS STARBUCKS\" --json",
      ].join("\n"),
    );

  merchants
    .command("list")
    .description("List merchants")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(listMerchants));

  merchants
    .command("resolve")
    .description("Resolve a merchant from a descriptor")
    .option("--descriptor <text>", "raw transaction descriptor")
    .action(runAction(resolveMerchant));

  merchants
    .command("upsert")
    .description("Create or update a merchant")
    .option("--name <name>", "merchant canonical name")
    .option("--alias <alias>", "merchant alias to add")
    .option("--default-account <id>", "default account id")
    .action(runAction(upsertMerchant));

  merchants
    .command("set-default")
    .description("Set or clear a merchant's default account")
    .option("--merchant <id>", "merchant id")
    .option("--account <id>", "account id")
    .option("--clear", "clear the default account instead of setting one")
    .action(runAction(setMerchantDefault));

  merchants
    .command("merge")
    .description("Merge one merchant into another")
    .option("--from <id>", "merchant id to merge from")
    .option("--to <id>", "merchant id to merge into")
    .option("--yes", "skip confirmation")
    .action(runAction(mergeMerchants));
}
