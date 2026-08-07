import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { createAccount } from "../../accounts/accounts.js";
import { insertTransaction } from "../../db/queries/transactions.js";
import { recordQuestion } from "../../db/queries/questions.js";
import {
  createSandbox,
  writeConf,
  makeRunCLI,
  parseNdjson,
  parseOne,
  type CLIRunner,
  type Sandbox,
} from "../../../fixtures/sandbox.js";

let sandbox: Sandbox;
let dbPath: string;
let runCLI: CLIRunner;

beforeAll(() => {
  sandbox = createSandbox("oled-system-it-");
  runCLI = makeRunCLI(sandbox);
  dbPath = sandbox.dbPath;

  // Minimal config.json so `doctor`'s config_exists check is true and bare `config` resolves.
  writeConf(sandbox, { displayCurrency: "THB", displayLocale: "th-TH", userName: "Test User" });

  // Shared db: every test below seeds rows against this one file.
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
    "config --init on a fresh env creates the db and data dir, and bare config reflects them",
    async () => {
      const isolated = createSandbox("oled-system-setup-it-");
      try {
        const setupDataDir = isolated.dataDir;
        const setupDbPath = isolated.dbPath;

        const setup = await runCLI(
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

        const show = await runCLI(["config", "--json"], { env: isolated.env, cwd: isolated.root });
        expect(show.code).toBe(0);
        const cfg = parseOne(show.stdout);
        expect(cfg.dataDir).toBe(setupDataDir);
        expect(cfg.dbPath).toBe(setupDbPath);
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
        const res = await runCLI(["config", "--country", "bogus", "--json"], {
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
        const before = await runCLI(["status", "--json"], { env: isolated.env, cwd: isolated.root });
        expect(before.code).toBe(0);
        const blank = parseOne(before.stdout);
        // The wire discriminator agents read the payload by; a rename breaks them.
        expect(blank.type).toBe("status");
        expect(blank.configured).toBe(false);
        expect(blank.db.reachable).toBe(false);
        expect(blank.db.error).toBe("no ledger yet");
        // Orienting must not bring a ledger into existence.
        expect(existsSync(isolated.dbPath)).toBe(false);
        expect(existsSync(isolated.confPath)).toBe(false);

        // Doctor diagnoses the same state without provisioning it either.
        const virginDoctor = await runCLI(["doctor", "--json"], { env: isolated.env, cwd: isolated.root });
        expect(virginDoctor.code).toBe(3); // EXIT.NOT_READY
        const dbOpen = parseOne(virginDoctor.stdout).checks.find(
          (c: { name: string }) => c.name === "db_open",
        );
        expect(dbOpen.ok).toBe(false);
        expect(dbOpen.detail).toContain("no ledger yet");
        expect(existsSync(isolated.dbPath)).toBe(false);

        // Bare --init, no companion flags: the env-resolved paths suffice.
        const init = await runCLI(["config", "--init", "--json"], {
          env: isolated.env,
          cwd: isolated.root,
        });
        expect(init.code).toBe(0);

        const after = await runCLI(["status", "--json"], { env: isolated.env, cwd: isolated.root });
        expect(after.code).toBe(0);
        const report = parseOne(after.stdout);
        expect(report.configured).toBe(true);
        expect(report.db.reachable).toBe(true);
        // Paths are home-relativized facts, never redaction fodder; only config_path sits under HOME here.
        expect(report.config_path.startsWith("~/")).toBe(true);
        expect(JSON.stringify(report)).not.toContain("[USER");
        expect(JSON.stringify(report)).not.toContain("[PARTNER");
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
          // A noun without a verb: commander's help screen on stderr is not a line --json allows.
          args: ["files"],
          message: "oled files needs a subcommand",
          hint: "one of: list, show, drop",
        },
      ];

      const runs = await Promise.all(cases.map((c) => runCLI([...c.args, "--json"])));
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
        runCLI(["ingest", "list", "--nope"]),
        runCLI(["files"]),
        runCLI(["--help"]),
        runCLI(["--version"]),
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
    "config: an ocr model persists without a url, and the model card stays out of the surface",
    async () => {
      const isolated = createSandbox("oled-system-ocr-cfg-it-");
      const env = { env: isolated.env, cwd: isolated.root };
      try {
        const model = await runCLI(
          ["config", "--db", isolated.dbPath, "--data-dir", isolated.dataDir, "--ocr-model", "test-ocr-model", "--json"],
          env,
        );
        expect(model.code).toBe(0);
        expect(parseOne(model.stdout)).toMatchObject({
          ocrBaseUrl: "",
          ocrModel: "test-ocr-model",
        });

        const show = await runCLI(["config", "--json"], env);
        expect(show.code).toBe(0);
        const shown = parseOne(show.stdout);
        expect(shown).toMatchObject({ ocrModel: "test-ocr-model" });
        // The model is the only OCR knob; the model card it selects is internal.
        expect(shown).not.toHaveProperty("ocrModelCard");
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
        createAccount(raw, { id: "thb:asset", name: "Assets", type: "asset", parent_id: null });
        createAccount(raw, { id: "thb:asset:bank", name: "Bank", type: "asset", parent_id: "thb:asset" });
        createAccount(raw, { id: "thb:income", name: "Income", type: "income", parent_id: null });
        createAccount(raw, { id: "thb:income:salary", name: "Salary", type: "income", parent_id: "thb:income" });
        createAccount(raw, { id: "thb:expense", name: "Expenses", type: "expense", parent_id: null });
        createAccount(raw, { id: "thb:expense:food", name: "Food", type: "expense", parent_id: "thb:expense" });

        insertTransaction(raw, {
          date: "2026-01-15",
          description: "Salary deposit",
          debit_account_id: "thb:asset:bank",
          credit_account_id: "thb:income:salary",
          amount: 100000,
        });
        insertTransaction(raw, {
          date: "2026-01-20",
          description: "Grocery run",
          debit_account_id: "thb:expense:food",
          credit_account_id: "thb:asset:bank",
          amount: 20000,
        });
      } finally {
        raw.close();
      }

      const status = await runCLI(["status", "--json"]);
      expect(status.code).toBe(0);
      const statusObj = parseOne(status.stdout);
      // Currency-keyed decimal maps, key for key; this ledger has no liability account, so that map is empty.
      expect(statusObj.net_worth).toEqual({
        assets: { THB: 800 },
        liabilities: {},
        net_worth: { THB: 800 },
      });

      const period = await runCLI(["report", "--from", "2026-01-01", "--to", "2026-01-31", "--json"]);
      expect(period.code).toBe(0);
      expect(parseOne(period.stdout)).toEqual({
        from: "2026-01-01",
        to: "2026-01-31",
        income: { THB: 1000 },
        expenses: { THB: 200 },
        net: { THB: 800 },
      });
    },
    30000,
  );

  it(
    "questions list/answer/defer round-trip",
    async () => {
      // Depends on the `thb:expense:food` account seeded by the report test above.
      let q1 = "";
      let q2 = "";
      const raw = new Database(dbPath);
      raw.pragma("foreign_keys = ON");
      try {
        q1 = recordQuestion(raw, {
          file_id: null,
          account_id: "thb:expense:food",
          kind: "uncategorized",
          prompt: "Which category for this recurring charge?",
          context: { rule_key: "merchant:acme-foodmart" },
        });
        q2 = recordQuestion(raw, {
          file_id: null,
          account_id: "thb:expense:food",
          kind: "duplicate",
          prompt: "Possible duplicate: snooze for later review?",
        });
      } finally {
        raw.close();
      }

      const list = await runCLI(["questions", "list", "--json"]);
      expect(list.code).toBe(0);
      const rows = parseNdjson(list.stdout);
      expect(rows.find((r) => r.id === q1)).toMatchObject({
        kind: "uncategorized",
        account_id: "thb:expense:food",
        context: { rule_key: "merchant:acme-foodmart" },
      });
      expect(rows.find((r) => r.id === q2)).toMatchObject({ kind: "duplicate", context: null });

      // The cap must announce itself via the summary, else a batch larger than it reads as complete.
      // `returned` is checked against rows actually emitted; the db is shared, hence the floor on total.
      const summary = rows.find((r) => r.type === "summary")!;
      expect(summary.returned).toBe(rows.length - 1);
      expect(summary.total).toBeGreaterThanOrEqual(2);
      expect(summary).toMatchObject({ has_more: false, limit: 200 });

      const capped = parseNdjson((await runCLI(["questions", "list", "--limit", "1", "--json"])).stdout);
      expect(capped.filter((r) => r.type !== "summary")).toHaveLength(1);
      expect(capped.find((r) => r.type === "summary")).toMatchObject({
        returned: 1,
        has_more: true,
        limit: 1,
      });

      const answer = await runCLI(["questions", "answer", q1, "--answer", "thb:expense:food:groceries", "--json"]);
      expect(answer.code).toBe(0);
      expect(parseNdjson(answer.stdout)).toEqual([
        { id: q1, kind: "uncategorized", answer: "thb:expense:food:groceries", rule_key: "merchant:acme-foodmart" },
      ]);

      const defer = await runCLI(["questions", "defer", q2, "--days", "5", "--json"]);
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
      const add = await runCLI([
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

      const list = await runCLI(["notes", "list", "--json"]);
      expect(list.code).toBe(0);
      expect(parseNdjson(list.stdout).some((n) => n.id === noteId)).toBe(true);

      const rm = await runCLI(["notes", "rm", String(noteId), "--yes", "--json"]);
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
    "accounts show: a prefix-less id on a seeded ledger is NOT_FOUND (5) with a ledger-enumerating hint",
    async () => {
      const isolated = createSandbox("oled-system-account-notfound-it-");
      try {
        writeConf(isolated, {});
        const raw = new Database(isolated.dbPath);
        raw.pragma("foreign_keys = ON");
        migrate(raw);
        try {
          createAccount(raw, { id: "thb:expense", name: "Expenses", type: "expense", parent_id: null });
          createAccount(raw, {
            id: "thb:expense:food",
            name: "Food",
            type: "expense",
            parent_id: "thb:expense",
          });
        } finally {
          raw.close();
        }

        const res = await runCLI(["accounts", "show", "expense:food", "--json"], {
          env: isolated.env,
          cwd: isolated.root,
        });
        expect(res.code).toBe(5);
        const err = parseOne(res.stderr).error;
        expect(err.code).toBe("E_NOT_FOUND");
        expect(err.message).toBe('account "expense:food" not found');
        expect(err.hint).toBe("account ids start with a currency — existing ledgers: thb");
      } finally {
        isolated.cleanup();
      }
    },
    30000,
  );

  it(
    "merchants upsert: an empty --name is USAGE (2), not a leaked GENERIC",
    async () => {
      const res = await runCLI(["merchants", "upsert", "--name", "   ", "--json"]);
      expect(res.code).toBe(2);
      expect(res.stdout.trim()).toBe("");
      const err = parseOne(res.stderr).error;
      expect(err.code).toBe("E_USAGE");
      expect(err.message).toBe("--name required");
    },
    30000,
  );

  it(
    "doctor: healthy env exits 0, corrupted db file exits NOT_READY (3)",
    async () => {
      const healthy = await runCLI(["doctor", "--json"]);
      expect(healthy.code).toBe(0);
      const report = parseOne(healthy.stdout);
      expect(report.ok).toBe(true);
      const byName = Object.fromEntries(report.checks.map((c: any) => [c.name, c]));
      expect(byName.db_open.ok).toBe(true);
      expect(byName.schema_tables_present.ok).toBe(true);

      // Intentionally the last test in this file: everything above depends on this db being readable.
      writeFileSync(dbPath, Buffer.from("not a sqlite file"));

      const corrupted = await runCLI(["doctor", "--json"]);
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
