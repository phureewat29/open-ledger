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
 * `vault`: manages file-password patterns for unlocking encrypted statements
 * non-interactively. Passwords are encrypted at rest (see pdf.ts's
 * savePassword); this surface never prints plaintext.
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

interface AddVaultEntryOpts {
  passwordStdin?: boolean;
}

async function addVaultEntry(pattern: string, _opts: AddVaultEntryOpts): Promise<void> {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch (err) {
    fail("USAGE", `invalid regex pattern: ${(err as Error).message}`);
  }

  const password = await readSecretFromStdin();
  if (!password) {
    fail("INPUT_REQUIRED", "no password on stdin", {
      hint: "pipe the password via --password-stdin, e.g. `printf %s 'secret' | plasalid vault add <pattern> --password-stdin`",
    });
  }

  const db = await openDb();
  const { savePassword } = await import("../../ingest/pdf.js");
  const id = savePassword(db, pattern, password, config.dbEncryptionKey);
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
    .description("Add a vault entry for a file pattern (password read from stdin)")
    .option("--password-stdin", "read a password from stdin")
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
