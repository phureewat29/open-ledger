import type { Command } from "commander";
import {
  emitList,
  emitObject,
  emitCappedSummary,
  fail,
  mapNotFoundError,
  redactionEnabled,
  requireYes,
  runAction,
  type Column,
} from "../output.js";
import { openDb } from "../db.js";
import {
  listMerchants as queryMerchants,
  claimAlias,
  clampMerchantsLimit,
  countMerchants,
  findMerchantByAlias,
  findMerchantById,
  findMerchantByName,
  renameMerchant,
  upsertMerchant as upsertMerchantRow,
  setMerchantDefaultAccount,
  clearMerchantDefaultAccount,
  mergeMerchants as mergeMerchantRows,
  type MerchantRow,
  type MerchantUpsertInput,
} from "../../db/queries/merchants.js";
import { requireAccount } from "../accounts.js";
import { noiseTokens } from "../../datasets/noise.js";
import { config } from "../../config.js";
import { applyRedaction } from "../../privacy/redactor.js";
import * as z from "zod";
import { parseInput, str, bool, int } from "../../lib/validate.js";
import { clampOffset } from "../../lib/limit.js";

// `canonical_name` is the only free-text field; ids and the default-account link are structured data left verbatim.
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

const LIST_MERCHANTS_SPEC = z.object({
  limit: int().optional(),
  offset: int().optional(),
});

async function listMerchants(opts: ListMerchantsOpts): Promise<void> {
  const parsed = parseInput(LIST_MERCHANTS_SPEC, opts as Record<string, unknown>);
  const db = await openDb();
  const rows = applyRedaction(
    queryMerchants(db, { limit: parsed.limit, offset: parsed.offset }),
    redactionEnabled(opts),
    MERCHANT_REDACT_FIELDS,
  );
  emitList(rows, MERCHANT_COLUMNS);
  emitCappedSummary(
    countMerchants(db),
    rows.length,
    clampMerchantsLimit(parsed.limit),
    clampOffset(parsed.offset),
  );
}

const RESOLVE_MERCHANT_SPEC = z.object({ descriptor: str() });

async function resolveMerchant(opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(RESOLVE_MERCHANT_SPEC, opts);
  const db = await openDb();
  const match = findMerchantByAlias(db, parsed.descriptor, noiseTokens(config.country));
  if (!match) {
    emitObject({ found: false });
    return;
  }
  emitObject({
    found: true,
    merchant_id: match.id,
    canonical_name: match.canonical_name,
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
  // An all-whitespace name is the flag not being passed, and reads that way.
  if (!parsed.name.trim()) fail("USAGE", "--name required");
  const db = await openDb();
  if (parsed.default_account) requireAccount(db, parsed.default_account);
  const input: MerchantUpsertInput = { canonical_name: parsed.name };
  if (parsed.alias) input.alias = parsed.alias;
  if (parsed.default_account) input.default_account_id = parsed.default_account;

  const merchant = upsertMerchantRow(db, input, noiseTokens(config.country));
  const payload: Record<string, unknown> = {
    id: merchant.id,
    canonical_name: merchant.canonical_name,
    default_account_id: merchant.default_account_id,
    created_at: merchant.created_at,
  };
  if (merchant.alias_conflict) payload.alias_conflict = merchant.alias_conflict;
  emitObject(payload);
}

const UPDATE_MERCHANT_SPEC = z.object({
  merchant: str(),
  name: str().optional(),
  alias: str().optional(),
  default_account: str().optional(),
});

async function updateMerchant(opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(UPDATE_MERCHANT_SPEC, opts, {
    atLeastOne: "at least one of --name, --alias, --default-account is required",
  });
  // An all-whitespace name is the flag not being passed, and reads that way.
  if (parsed.name !== undefined && !parsed.name.trim()) fail("USAGE", "--name required");
  const db = await openDb();
  const current = findMerchantById(db, parsed.merchant);
  if (!current) fail("NOT_FOUND", `merchant "${parsed.merchant}" not found`);

  const result: Record<string, unknown> = { merchant_id: parsed.merchant };
  const noise = noiseTokens(config.country);

  if (parsed.name) {
    const holder = findMerchantByName(db, parsed.name);
    if (holder && holder.id !== parsed.merchant) {
      fail("INVALID", `merchant name "${parsed.name.trim()}" already belongs to ${holder.id}`, {
        hint: `merge them instead: oled merchants merge --from ${parsed.merchant} --to ${holder.id} --yes`,
      });
    }
    const renamed = renameMerchant(db, parsed.merchant, parsed.name, noise);
    result.before = renamed.before;
    result.after = renamed.after;
    // The old name stays resolvable as an alias unless another merchant holds it.
    if (renamed.alias_conflict) result.alias_conflict = renamed.alias_conflict;
  }

  if (parsed.alias) {
    const conflict = claimAlias(db, parsed.merchant, parsed.alias, noise);
    if (conflict) result.alias_conflict = conflict;
    else result.alias_added = parsed.alias;
  }

  if (parsed.default_account) {
    requireAccount(db, parsed.default_account);
    const set = setMerchantDefaultAccount(db, parsed.merchant, parsed.default_account);
    result.default_account = set.after;
  }

  emitObject(result);
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
    emitObject({ merchant_id: parsed.merchant, before: result.before, after: null });
    return;
  }

  requireAccount(db, parsed.account!);
  const result = setMerchantDefaultAccount(db, parsed.merchant, parsed.account!);
  emitObject({ merchant_id: parsed.merchant, before: result.before, after: result.after });
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
  const payload: Record<string, unknown> = {
    from: parsed.from,
    to: parsed.to,
    moved_transactions: result.moved_transactions,
    moved_aliases: result.moved_aliases,
  };
  if (result.adopted_default_account !== undefined) {
    payload.adopted_default_account = result.adopted_default_account;
  }
  emitObject(payload);
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
        "Cleaning names: `update --merchant <id> --name <clean>` renames in place and keeps the raw name as an alias.",
        "Example: oled merchants resolve --descriptor \"POS STARBUCKS\" --json",
      ].join("\n"),
    );

  merchants
    .command("list")
    .description("List merchants")
    .option("--limit <n>", "max rows (default 200, max 1000)")
    .option("--offset <n>", "rows to skip; repeat with offset += returned while the summary says has_more")
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
    .option("--default-account <id>", "default account id, currency-prefixed (e.g. thb:expense:food)")
    .action(runAction(upsertMerchant));

  merchants
    .command("update")
    .description("Rename a merchant or add an alias; the old name keeps resolving")
    .option("--merchant <id>", "merchant id")
    .option("--name <name>", "new canonical name (the old one is kept as an alias)")
    .option("--alias <alias>", "additional alias to claim")
    .option("--default-account <id>", "default account id, currency-prefixed (e.g. thb:expense:food)")
    .addHelpText(
      "after",
      "\nNote: `transactions add --merchant-name` matches by name, so the old spelling there would create a new merchant; prefer ids after a rename.",
    )
    .action(runAction(updateMerchant));

  merchants
    .command("set-default")
    .description("Set or clear a merchant's default account")
    .option("--merchant <id>", "merchant id")
    .option("--account <id>", "account id, currency-prefixed (e.g. thb:expense:food)")
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
