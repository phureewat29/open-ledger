import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { createAccount } from "../../accounts/accounts.js";
import { insertTransaction } from "../../db/queries/transactions.js";
import { recordQuestion } from "../../db/queries/questions.js";
import { createSandbox, type Sandbox } from "../../lib/sandbox.js";

/**
 * Repo root is three levels up from src/cli/commands/. Covers questions,
 * report, notes, config, and doctor via spawned CLI processes.
 */
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const cliEntry = resolve(repoRoot, "src", "cli", "index.ts");

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

let sandbox: Sandbox;
let dbPath: string;

beforeAll(() => {
  sandbox = createSandbox("oled-system-it-");
  dbPath = sandbox.dbPath;

  // Minimal config.json so `doctor`'s config_exists check is true and `config show` resolves.
  mkdirSync(join(sandbox.home, ".oled"), { recursive: true });
  writeFileSync(
    join(sandbox.home, ".oled", "config.json"),
    JSON.stringify({ displayCurrency: "THB", displayLocale: "th-TH", userName: "Test User" }, null, 2) + "\n",
  );

  // Create + migrate the shared (unencrypted) db once; tests below seed their own rows against it.
  const raw = new Database(dbPath);
  raw.pragma("foreign_keys = ON");
  migrate(raw);
  raw.close();
});

afterAll(() => {
  sandbox.cleanup();
});

function runCli(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      "npx",
      ["tsx", cliEntry, ...args],
      {
        cwd: opts.cwd ?? sandbox.root,
        env: opts.env ?? sandbox.env,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
    child.stdin?.end();
  });
}

function parseOne(stdout: string): any {
  const lines = stdout.trim().split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

function parseNdjson(stdout: string): any[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("system CLI integration (subprocess)", () => {
  it(
    "config --generate-key on a fresh env: config show reflects it redacted, never plaintext",
    async () => {
      const isolated = createSandbox("oled-system-setup-it-");
      try {
        const setupDataDir = isolated.dataDir;
        const setupDbPath = isolated.dbPath;

        const setup = await runCli(
          [
            "config",
            "--data-dir",
            setupDataDir,
            "--db",
            setupDbPath,
            "--generate-key",
            "--user-name",
            "Fresh User",
            "--currency",
            "THB",
            "--locale",
            "th-TH",
            "--json",
          ],
          { env: isolated.env, cwd: isolated.root },
        );
        expect(setup.code).toBe(0);
        const setupResult = parseOne(setup.stdout);
        expect(setupResult.dbEncryptionKey).toMatchObject({ set: true });
        expect(setupResult.dbEncryptionKey.fingerprint).toMatch(/^sha256:[0-9a-f]{8}$/);
        expect(setupResult.created).toMatchObject({ db: setupDbPath, data_dir: setupDataDir });
        // The raw 64-hex-char generated key must never appear on stdout.
        expect(/[0-9a-f]{64}/i.test(setup.stdout)).toBe(false);

        const show = await runCli(["config", "show", "--json"], { env: isolated.env, cwd: isolated.root });
        expect(show.code).toBe(0);
        const cfg = parseOne(show.stdout);
        expect(cfg.dbEncryptionKey).toMatchObject({
          set: true,
          fingerprint: setupResult.dbEncryptionKey.fingerprint,
        });
        expect(cfg.dataDir).toBe(setupDataDir);
        expect(cfg.dbPath).toBe(setupDbPath);
        expect(/[0-9a-f]{64}/i.test(show.stdout)).toBe(false);
      } finally {
        isolated.cleanup();
      }
    },
    30000,
  );

  it(
    "config --generate-key re-run keeps the live key instead of orphaning the encrypted db",
    async () => {
      const isolated = createSandbox("oled-system-rekey-it-");
      try {
        const first = await runCli(
          ["config", "--db", isolated.dbPath, "--data-dir", isolated.dataDir, "--generate-key", "--json"],
          { env: isolated.env, cwd: isolated.root },
        );
        expect(first.code).toBe(0);
        const fingerprint = parseOne(first.stdout).dbEncryptionKey.fingerprint;

        const second = await runCli(["config", "--generate-key", "--json"], {
          env: isolated.env,
          cwd: isolated.root,
        });
        expect(second.code).toBe(0);
        expect(parseOne(second.stdout).dbEncryptionKey).toMatchObject({ set: true, fingerprint });
      } finally {
        isolated.cleanup();
      }
    },
    30000,
  );

  it(
    "config --generate-key refuses to key an existing keyless db (INVALID) and leaves it usable",
    async () => {
      const isolated = createSandbox("oled-system-plain-db-it-");
      try {
        // Any db-touching command run with the sandbox's blank key creates a
        // plain db first — the agent-bootstrap path the demo exercises.
        const seed = await runCli(["status", "--json"], { env: isolated.env, cwd: isolated.root });
        expect(seed.code).toBe(0);

        const rekey = await runCli(["config", "--generate-key", "--json"], {
          env: isolated.env,
          cwd: isolated.root,
        });
        expect(rekey.code).toBe(6);
        const err = JSON.parse(rekey.stderr.trim());
        expect(err.error.code).toBe("E_INVALID");
        expect(err.error.hint).toBeDefined();

        // Nothing was persisted: the harness still opens the plain db, and
        // status reports configured (a db is in place; no first-run needed).
        const status = await runCli(["status", "--json"], { env: isolated.env, cwd: isolated.root });
        expect(status.code).toBe(0);
        const report = parseOne(status.stdout);
        expect(report.db.reachable).toBe(true);
        expect(report.configured).toBe(true);
      } finally {
        isolated.cleanup();
      }
    },
    30000,
  );

  it(
    "status net_worth + report reflect directly-seeded ledger data",
    async () => {
      const raw = new Database(dbPath);
      raw.pragma("foreign_keys = ON");
      try {
        createAccount(raw, { id: "asset", name: "Assets", type: "asset", parent_id: null });
        createAccount(raw, { id: "asset:bank", name: "Bank", type: "asset", parent_id: "asset" });
        createAccount(raw, { id: "income", name: "Income", type: "income", parent_id: null });
        createAccount(raw, { id: "income:salary", name: "Salary", type: "income", parent_id: "income" });
        createAccount(raw, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
        createAccount(raw, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });

        insertTransaction(raw, {
          date: "2026-01-15",
          description: "Salary deposit",
          debit_account_id: "asset:bank",
          credit_account_id: "income:salary",
          amount: 100000,
          currency: "THB",
        });
        insertTransaction(raw, {
          date: "2026-01-20",
          description: "Grocery run",
          debit_account_id: "expense:food",
          credit_account_id: "asset:bank",
          amount: 20000,
          currency: "THB",
        });
      } finally {
        raw.close();
      }

      const status = await runCli(["status", "--json"]);
      expect(status.code).toBe(0);
      const statusObj = parseOne(status.stdout);
      expect(statusObj.net_worth).toMatchObject({
        assets: 800,
        liabilities: 0,
        net_worth: 800,
      });

      const period = await runCli(["report", "--from", "2026-01-01", "--to", "2026-01-31", "--json"]);
      expect(period.code).toBe(0);
      expect(parseOne(period.stdout)).toMatchObject({
        from: "2026-01-01",
        to: "2026-01-31",
        income: 1000,
        expenses: 200,
        net: 800,
      });
    },
    30000,
  );

  it(
    "questions list/answer/defer round-trip",
    async () => {
      // Depends on the `expense:food` account seeded by the report test above.
      let q1 = "";
      let q2 = "";
      const raw = new Database(dbPath);
      raw.pragma("foreign_keys = ON");
      try {
        q1 = recordQuestion(raw, {
          file_id: null,
          account_id: "expense:food",
          kind: "uncategorized",
          prompt: "Which category for this recurring charge?",
          options: ["expense:food", "expense:other"],
          context: { rule_key: "merchant:acme-foodmart" },
        });
        q2 = recordQuestion(raw, {
          file_id: null,
          account_id: "expense:food",
          kind: "duplicate",
          prompt: "Possible duplicate — snooze for later review?",
        });
      } finally {
        raw.close();
      }

      const list = await runCli(["questions", "list", "--json"]);
      expect(list.code).toBe(0);
      const rows = parseNdjson(list.stdout);
      expect(rows.find((r) => r.id === q1)).toMatchObject({
        kind: "uncategorized",
        account_id: "expense:food",
        options: ["expense:food", "expense:other"],
        context: { rule_key: "merchant:acme-foodmart" },
      });
      expect(rows.find((r) => r.id === q2)).toMatchObject({ kind: "duplicate", context: null });

      const answer = await runCli(["questions", "answer", q1, "--answer", "expense:food:groceries", "--json"]);
      expect(answer.code).toBe(0);
      expect(parseNdjson(answer.stdout)).toEqual([
        { id: q1, kind: "uncategorized", answer: "expense:food:groceries", rule_key: "merchant:acme-foodmart" },
      ]);

      const defer = await runCli(["questions", "defer", q2, "--days", "5", "--json"]);
      expect(defer.code).toBe(0);
      expect(parseNdjson(defer.stdout)).toEqual([{ id: q2, days: 5 }]);

      // Verify the underlying effect directly rather than spending another spawn.
      const raw2 = new Database(dbPath);
      try {
        expect(raw2.prepare("SELECT id FROM questions WHERE id = ?").get(q1)).toBeUndefined();
        const deferred = raw2.prepare("SELECT deferred_until FROM questions WHERE id = ?").get(q2) as
          | { deferred_until: string }
          | undefined;
        expect(deferred?.deferred_until).toBeTruthy();
      } finally {
        raw2.close();
      }
    },
    30000,
  );

  it(
    "notes add/list/rm round-trip",
    async () => {
      const add = await runCli([
        "notes",
        "add",
        "--content",
        "Prefers window seats on flights",
        "--category",
        "preference",
        "--json",
      ]);
      expect(add.code).toBe(0);
      const added = parseNdjson(add.stdout);
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ content: "Prefers window seats on flights", category: "preference" });
      const noteId = added[0].id as number;

      const list = await runCli(["notes", "list", "--json"]);
      expect(list.code).toBe(0);
      expect(parseNdjson(list.stdout).some((n) => n.id === noteId)).toBe(true);

      const rm = await runCli(["notes", "rm", String(noteId), "--yes", "--json"]);
      expect(rm.code).toBe(0);
      expect(parseNdjson(rm.stdout)).toEqual([
        expect.objectContaining({ id: noteId, content: "Prefers window seats on flights" }),
      ]);

      const raw = new Database(dbPath);
      try {
        expect(raw.prepare("SELECT id FROM notes WHERE id = ?").get(noteId)).toBeUndefined();
      } finally {
        raw.close();
      }
    },
    30000,
  );

  it(
    "doctor: healthy env exits 0, corrupted db file exits NOT_READY (3)",
    async () => {
      const healthy = await runCli(["doctor", "--json"]);
      expect(healthy.code).toBe(0);
      const report = parseOne(healthy.stdout);
      expect(report.ok).toBe(true);
      const byName = Object.fromEntries(report.checks.map((c: any) => [c.name, c]));
      expect(byName.db_open.ok).toBe(true);
      expect(byName.schema_tables_present.ok).toBe(true);

      // Corrupt the shared db file in place. Intentionally the LAST test in
      // this file: everything above depends on this db being readable.
      writeFileSync(dbPath, Buffer.from("not a sqlite file"));

      const corrupted = await runCli(["doctor", "--json"]);
      expect(corrupted.code).toBe(3);
      const corruptedReport = parseOne(corrupted.stdout);
      expect(corruptedReport.ok).toBe(false);
      const corruptedByName = Object.fromEntries(corruptedReport.checks.map((c: any) => [c.name, c]));
      expect(corruptedByName.db_open.ok).toBe(false);
      expect(corruptedByName.schema_tables_present.ok).toBe(false);
    },
    30000,
  );
});
