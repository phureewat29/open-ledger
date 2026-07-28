import type { Command } from "commander";
import { config } from "../../config.js";
import {
  type Column,
  emitList,
  emitObject,
  fail,
  readSecretFromStdin,
  requireYes,
  runAction,
} from "../output.js";
import { openDb } from "../db.js";

/**
 * Passwords are encrypted at rest (see src/db/queries/vault.ts); this surface
 * never prints plaintext.
 */

// Erased type query: the stored-password row shape without pulling the db
// module onto the startup path.
type VaultRow = ReturnType<typeof import("../../db/queries/vault.js").listPasswords>[number];

const VAULT_COLUMNS: Column<VaultRow>[] = [
  { header: "ID", value: (r) => r.id },
  { header: "Pattern", value: (r) => r.pattern },
  { header: "Uses", value: (r) => String(r.use_count), align: "right" },
  { header: "Last Used", value: (r) => r.last_used_at ?? "-" },
];

async function addVaultEntry(pattern: string): Promise<void> {
  try {
    new RegExp(pattern);
  } catch (err) {
    fail("USAGE", `invalid regex pattern: ${(err as Error).message}`, {
      hint: "a pattern is a regex matched against the file name, e.g. '^kbank.*' — see `oled vault add --help`",
    });
  }

  const password = await readSecretFromStdin();
  if (!password) {
    fail("INPUT_REQUIRED", "no password on stdin", {
      hint: "the password is read from stdin, e.g. `printf %s 'secret' | oled vault add <pattern>`",
    });
  }

  const db = await openDb();
  const { upsertPassword } = await import("../../db/queries/vault.js");
  const id = upsertPassword(db, pattern, password, config.dbEncryptionKey);
  emitObject({ id, pattern });
}

async function listVaultEntries(): Promise<void> {
  const db = await openDb();
  const { listPasswords } = await import("../../db/queries/vault.js");
  const rows = listPasswords(db);
  emitList(rows, VAULT_COLUMNS);
}

interface RemoveVaultEntryOpts {
  yes?: boolean;
}

async function removeVaultEntry(patternOrId: string, opts: RemoveVaultEntryOpts): Promise<void> {
  requireYes(opts, `removing vault entry "${patternOrId}"`);
  const db = await openDb();
  const { deletePassword } = await import("../../db/queries/vault.js");
  if (!deletePassword(db, patternOrId)) {
    fail("NOT_FOUND", `no vault entry matching "${patternOrId}"`);
  }
  emitObject({ pattern_or_id: patternOrId, removed: true });
}

export function registerVault(program: Command): void {
  const vault = program.command("vault").description("Manage file-password patterns for encrypted statements");

  vault
    .command("add <pattern>")
    .description("Add a vault entry for a file-name pattern (pipe the password on stdin)")
    .addHelpText(
      "after",
      [
        "",
        "Pattern: a regex matched case-insensitively against the file NAME only — not the relative path `ingest list` shows.",
        "Example: printf %s 'secret' | oled vault add '^kbank.*' --json",
      ].join("\n"),
    )
    .action(runAction(addVaultEntry));

  vault
    .command("list")
    .description("List vault entries (never prints stored passwords)")
    .action(runAction(listVaultEntries));

  vault
    .command("rm <patternOrId>")
    .description("Remove a vault entry")
    .option("--yes", "skip confirmation")
    .action(runAction(removeVaultEntry));
}
