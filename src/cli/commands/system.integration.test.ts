import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { createAccount } from "../../accounts/accounts.js";
import { insertTransaction } from "../../db/queries/transactions.js";
import { recordQuestion } from "../../db/queries/questions.js";
import {
  createSandbox,
  makeRunCli,
  parseNdjson,
  parseOne,
  type CliRunner,
  type Sandbox,
} from "../../../fixtures/sandbox.js";

let sandbox: Sandbox;
let dbPath: string;
let runCli: CliRunner;

beforeAll(() => {
  sandbox = createSandbox("oled-system-it-");
  runCli = makeRunCli(sandbox);
  dbPath = sandbox.dbPath;

  // Minimal config.json so `doctor`'s config_exists check is true and `config show` resolves.
  mkdirSync(join(sandbox.home, ".oled"), { recursive: true });
  writeFileSync(
    join(sandbox.home, ".oled", "config.json"),
    JSON.stringify({ displayCurrency: "THB", displayLocale: "th-TH", userName: "Test User" }, null, 2) + "\n",
  );

  // Create + migrate the shared db once; tests below seed their own rows against it.
  const raw = new Database(dbPath);
  raw.pragma("foreign_keys = ON");
  migrate(raw);
  raw.close();
});

afterAll(() => {
  sandbox.cleanup();
});

describe("system CLI integration (subprocess)", () => {
  it(
    "config --init on a fresh env creates the db and data dir, and config show reflects them",
    async () => {
      const isolated = createSandbox("oled-system-setup-it-");
      try {
        const setupDataDir = isolated.dataDir;
        const setupDbPath = isolated.dbPath;

        const setup = await runCli(
          [
            "config",
            "--init",
            "--data-dir",
            setupDataDir,
            "--db",
            setupDbPath,
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
        expect(setupResult.created).toMatchObject({ db: setupDbPath, data_dir: setupDataDir });

        const show = await runCli(["config", "show", "--json"], { env: isolated.env, cwd: isolated.root });
        expect(show.code).toBe(0);
        const cfg = parseOne(show.stdout);
        expect(cfg.dataDir).toBe(setupDataDir);
        expect(cfg.dbPath).toBe(setupDbPath);
        // No database key of any kind reaches the config; absence is the contract.
        expect(setupResult).not.toHaveProperty("dbEncryptionKey");
        expect(cfg).not.toHaveProperty("dbEncryptionKey");
      } finally {
        isolated.cleanup();
      }
    },
    30000,
  );

  it(
    "config rejects an unknown --country with USAGE and names the ones it has",
    async () => {
      const isolated = createSandbox("oled-system-country-it-");
      try {
        const res = await runCli(["config", "--country", "bogus", "--json"], {
          env: isolated.env,
          cwd: isolated.root,
        });
        expect(res.code).toBe(2);
        const err = JSON.parse(res.stderr.trim());
        expect(err.error.code).toBe("E_USAGE");
        expect(err.error.message).toContain("bogus");
        expect(err.error.hint).toContain("TH");
      } finally {
        isolated.cleanup();
      }
    },
    30000,
  );

  it(
    "status on a virgin env creates no ledger, and reports one after config --init",
    async () => {
      const isolated = createSandbox("oled-system-virgin-it-");
      try {
        const before = await runCli(["status", "--json"], { env: isolated.env, cwd: isolated.root });
        expect(before.code).toBe(0);
        const blank = parseOne(before.stdout);
        expect(blank.configured).toBe(false);
        expect(blank.db.reachable).toBe(false);
        // Orienting must not bring a ledger into existence — the trap this closes.
        expect(existsSync(isolated.dbPath)).toBe(false);
        expect(existsSync(join(isolated.home, ".oled", "config.json"))).toBe(false);

        const init = await runCli(
          ["config", "--init", "--db", isolated.dbPath, "--data-dir", isolated.dataDir, "--json"],
          { env: isolated.env, cwd: isolated.root },
        );
        expect(init.code).toBe(0);

        const after = await runCli(["status", "--json"], { env: isolated.env, cwd: isolated.root });
        expect(after.code).toBe(0);
        const report = parseOne(after.stdout);
        expect(report.configured).toBe(true);
        expect(report.db.reachable).toBe(true);
        expect(report.db).not.toHaveProperty("encrypted");
        expect(report.db).not.toHaveProperty("key_fingerprint");
      } finally {
        isolated.cleanup();
      }
    },
    30000,
  );

  it(
    "commander parse failures land on the JSON error contract, not commander's plain text",
    async () => {
      const cases = [
        {
          args: ["ingest", "list", "--nope"],
          message: "unknown option '--nope'",
          hint: "run `oled ingest list --help` for its flags and usage",
        },
        {
          // The root takes no argument, so a mistyped command arrives as an excess one.
          args: ["bogus"],
          message: "unknown command 'bogus'",
          hint: "run `oled --help` for the list of commands",
        },
        {
          args: ["ingest", "bogus"],
          message: "unknown command 'bogus'",
          hint: "run `oled ingest --help` for its flags and usage",
        },
        {
          args: ["transactions", "show"],
          message: "missing required argument 'id'",
          hint: "run `oled transactions show --help` for its flags and usage",
        },
        {
          // A noun reached without a verb: commander answers with the noun's
          // help screen on stderr, which is not a line the contract allows.
          args: ["files"],
          message: "oled files needs a subcommand",
          hint: "one of: list, show, drop",
        },
      ];

      const runs = await Promise.all(cases.map((c) => runCli([...c.args, "--json"])));
      runs.forEach((run, i) => {
        const label = cases[i].args.join(" ");
        expect(run.code, label).toBe(2);
        expect(run.stdout, label).toBe("");
        const err = parseOne(run.stderr).error;
        expect(err, label).toMatchObject({
          code: "E_USAGE",
          message: cases[i].message,
          hint: cases[i].hint,
        });
      });
    },
    30000,
  );

  it(
    "parse failures stay readable without --json, and --help/--version keep exit 0",
    async () => {
      const [text, noun, help, version] = await Promise.all([
        runCli(["ingest", "list", "--nope"]),
        runCli(["files"]),
        runCli(["--help"]),
        runCli(["--version"]),
      ]);

      expect(text.code).toBe(2);
      expect(text.stderr).toBe(
        "error: unknown option '--nope'\nhint: run `oled ingest list --help` for its flags and usage\n",
      );

      // Help-first: a verbless noun still answers with its help screen, unchanged.
      expect(noun.code).toBe(1);
      expect(noun.stdout).toBe("");
      expect(noun.stderr).toContain("Usage: oled files");

      expect(help.code).toBe(0);
      expect(help.stdout).toContain("Usage");
      expect(version.code).toBe(0);
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
    30000,
  );

  it(
    "config: an ocr model persists without a url, and the preset stays out of the surface",
    async () => {
      const isolated = createSandbox("oled-system-ocr-cfg-it-");
      const env = { env: isolated.env, cwd: isolated.root };
      try {
        const model = await runCli(
          ["config", "--db", isolated.dbPath, "--data-dir", isolated.dataDir, "--ocr-model", "test-ocr-model", "--json"],
          env,
        );
        expect(model.code).toBe(0);
        expect(parseOne(model.stdout)).toMatchObject({
          ocrBaseUrl: "",
          ocrModel: "test-ocr-model",
        });

        const show = await runCli(["config", "show", "--json"], env);
        expect(show.code).toBe(0);
        const shown = parseOne(show.stdout);
        expect(shown).toMatchObject({ ocrModel: "test-ocr-model" });
        // The model is the only OCR knob; the preset it selects is internal.
        expect(shown).not.toHaveProperty("ocrPreset");
      } finally {
        isolated.cleanup();
      }
    },
    30000,
  );

  it(
    "config show fingerprints an env-supplied OCR api key rather than echoing it (there is no flag for it)",
    async () => {
      const show = await runCli(["config", "show", "--json"], {
        env: { ...sandbox.env, OLED_OCR_API_KEY: "sk-ocr-plaintext" },
      });
      expect(show.code).toBe(0);
      expect(parseOne(show.stdout).ocrApiKey).toMatchObject({
        set: true,
        fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{8}$/),
      });
      expect(show.stdout).not.toContain("sk-ocr-plaintext");
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
