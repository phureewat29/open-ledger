import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeSync, mkdirSync, openSync, readFileSync, truncateSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { createAccount } from "../../accounts/accounts.js";
import {
  createSandbox,
  makeRunCli,
  parseNdjson,
  type CliRunner,
  type Sandbox,
} from "../../../fixtures/sandbox.js";
import { MAX_SOURCE_BYTES, loadSource } from "../../extract/source.js";
import { encryptedPdf, pdfOf, textPdf } from "../../../fixtures/pdf.js";
import { samplePng } from "../../../fixtures/images.js";
import {
  DEAD_OCR_BASE_URL,
  liveOcr,
  liveOcrEnv,
  requireLiveOcr,
} from "../../../fixtures/ocr-endpoint.js";

let sandbox: Sandbox;
let runCli: CliRunner;
let dbPath: string;

beforeAll(() => {
  // createSandbox blanks OLED_DB_ENCRYPTION_KEY, so this file can read the db directly with `libsql`.
  sandbox = createSandbox("oled-ingest-it-");
  runCli = makeRunCli(sandbox);
  dbPath = sandbox.dbPath;

  // Closed before the CLI runs so the subprocess owns the writer.
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  db.close();
});

afterAll(() => {
  sandbox.cleanup();
});

function stage(relPath: string, bytes: Buffer): string {
  const path = join(sandbox.dataDir, relPath);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function readDb(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

describe("ingest commit v2 (subprocess)", () => {
  it("commits exact + silent well-formed placeholder + uncategorized fallback (only the fallback asks), exit 0", async () => {
    const ndjson = [
      JSON.stringify({
        date: "2026-01-02",
        description: "Groceries",
        debit_account: "expense:food",
        credit_account: "asset:cash",
        amount: 100,
      }),
      JSON.stringify({
        date: "2026-01-03",
        description: "New category charge",
        debit_account: "expense:totally-made-up-xyz",
        credit_account: "asset:cash",
        amount: 50,
      }),
      JSON.stringify({
        date: "2026-01-04",
        description: "Unresolvable charge",
        debit_account: "mysterious",
        credit_account: "asset:cash",
        amount: 25,
      }),
    ].join("\n");

    const { stdout, code } = await runCli(["ingest", "commit", "--json"], { stdin: ndjson });
    expect(code).toBe(0);

    const objs = parseNdjson(stdout);
    const results = objs.filter((o) => o.type === "result");
    const summary = objs.find((o) => o.type === "summary");
    expect(results).toHaveLength(3);

    const [r0, r1, r2] = results;

    expect(r0.ok).toBe(true);
    expect(typeof r0.transaction_id).toBe("string");
    expect(r0.transaction_id).toMatch(/^tx:/);
    expect(r0.duplicate).toBe(false);
    expect(r0.raised_questions).toBe(0);
    expect(r0.merchant.how).toBe("none");
    expect(r0.sides).toEqual([
      { side: "debit", requested: "expense:food", resolved: "expense:food", how: "exact" },
      { side: "credit", requested: "asset:cash", resolved: "asset:cash", how: "exact" },
    ]);

    expect(r1.ok).toBe(true);
    expect(r1.raised_questions).toBe(0);
    expect(r1.sides[0]).toEqual({
      side: "debit",
      requested: "expense:totally-made-up-xyz",
      resolved: "expense:totally-made-up-xyz",
      how: "placeholder_created",
    });
    expect(r1.sides[1].how).toBe("exact");

    expect(r2.ok).toBe(true);
    expect(r2.raised_questions).toBe(1);
    expect(r2.sides[0]).toEqual({
      side: "debit",
      requested: "mysterious",
      resolved: "expense:uncategorized",
      how: "uncategorized_fallback",
    });
    expect(r2.sides[1].how).toBe("exact");

    expect(summary).toBeDefined();
    expect(summary.batch_id).toMatch(/^ib:/);
    expect(summary.posted).toBe(3);
    expect(summary.duplicates).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.raised_questions).toBe(1);

    const db = readDb();
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM questions WHERE batch_id = ?").get(summary.batch_id) as {
        n: number;
      }
    ).n;
    const placeholderFlag = (
      db
        .prepare("SELECT has_question FROM accounts WHERE id = ?")
        .get("expense:totally-made-up-xyz") as { has_question: number } | undefined
    )?.has_question;
    db.close();
    expect(n).toBe(1);
    expect(placeholderFlag).toBe(0);
  }, 30000);

  it("reads the batch from a file via --input (agent file-staging path)", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "oled-input-"));
    const inputPath = join(dir, "batch.ndjson");
    writeFileSync(
      inputPath,
      JSON.stringify({
        date: "2026-01-05",
        description: "Staged via file",
        debit_account: "expense:food",
        credit_account: "asset:cash",
        amount: 42,
      }) + "\n",
    );

    const { stdout, code } = await runCli(["ingest", "commit", "--input", inputPath, "--json"]);
    expect(code).toBe(0);
    const objs = parseNdjson(stdout);
    expect(objs.find((o) => o.type === "summary")?.posted).toBe(1);

    const missing = await runCli(["ingest", "commit", "--input", join(dir, "nope.ndjson"), "--json"]);
    expect(missing.code).toBe(5);
  });

  it("returns exit 7 (PARTIAL) with a clean dirty_input result per bad row, never a raw SQL error", async () => {
    const ndjson = [
      JSON.stringify({
        date: "2026-02-01",
        description: "Valid",
        debit_account: "expense:food",
        credit_account: "asset:cash",
        amount: 20,
      }),
      JSON.stringify({
        date: "2026-02-02",
        description: "Self",
        debit_account: "expense:food",
        credit_account: "expense:food",
        amount: 5,
      }),
      JSON.stringify({
        description: "Missing date",
        debit_account: "expense:food",
        credit_account: "asset:cash",
        amount: 20,
      }),
    ].join("\n");

    const { stdout, stderr, code } = await runCli(["ingest", "commit", "--json"], { stdin: ndjson });
    expect(code).toBe(7); // EXIT.PARTIAL

    const objs = parseNdjson(stdout);
    const results = objs.filter((o) => o.type === "result");
    const summary = objs.find((o) => o.type === "summary");

    expect(results[0].ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false, reason: "dirty_input" });
    expect(typeof results[1].message).toBe("string");
    expect(results[2]).toMatchObject({ ok: false, reason: "dirty_input" });
    expect(results[2].message).toMatch(/ISO date/);
    expect(summary.posted).toBe(1);
    expect(summary.failed).toBe(2);

    expect(stderr).not.toMatch(/SQLITE|SQL error/i);
  }, 30000);

  it("is idempotent: a second commit of the same row reports duplicate:true, balance unchanged", async () => {
    const db = readDb();
    db.prepare(
      `INSERT INTO files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'pending')`,
    ).run("sf:idem", "/tmp/idem.pdf", "idem-hash", "application/pdf");
    db.close();

    const item = JSON.stringify({
      date: "2026-03-01",
      description: "Rent",
      debit_account: "expense:food",
      credit_account: "asset:cash",
      amount: 1000,
      row_index: 0,
    });

    const first = await runCli(["ingest", "commit", "--file", "sf:idem", "--json"], { stdin: item });
    expect(first.code).toBe(0);
    const firstObjs = parseNdjson(first.stdout);
    expect(firstObjs.find((o) => o.type === "result").duplicate).toBe(false);
    const firstSummary = firstObjs.find((o) => o.type === "summary");
    expect(firstSummary.posted).toBe(1);
    expect(firstSummary.duplicates).toBe(0);

    const second = await runCli(["ingest", "commit", "--file", "sf:idem", "--json"], { stdin: item });
    expect(second.code).toBe(0); // duplicates are a successful no-op
    const secondObjs = parseNdjson(second.stdout);
    const secondResult = secondObjs.find((o) => o.type === "result");
    expect(secondResult.ok).toBe(true);
    expect(secondResult.duplicate).toBe(true);
    const secondSummary = secondObjs.find((o) => o.type === "summary");
    expect(secondSummary.posted).toBe(0);
    expect(secondSummary.duplicates).toBe(1);
    expect(secondSummary.failed).toBe(0);

    const db2 = readDb();
    const n = (
      db2.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source_file_id = 'sf:idem'").get() as {
        n: number;
      }
    ).n;
    db2.close();
    expect(n).toBe(1);
  }, 45000);

  it("a duplicate re-commit reports the sides the stored row holds, not the ones this run would have resolved", async () => {
    const db = readDb();
    createAccount(db, { id: "expense:sides-a", name: "Sides A", type: "expense", parent_id: "expense" });
    createAccount(db, { id: "expense:sides-b", name: "Sides B", type: "expense", parent_id: "expense" });
    db.prepare(
      `INSERT INTO files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'pending')`,
    ).run("sf:dup-sides", "/tmp/dup-sides.pdf", "dup-sides-hash", "application/pdf");
    db.close();

    const item = JSON.stringify({
      date: "2026-03-10",
      description: "Recategorized after its first commit",
      debit_account: "expense:sides-a",
      credit_account: "asset:cash",
      amount: 33,
      row_index: 0,
    });

    const first = await runCli(["ingest", "commit", "--file", "sf:dup-sides", "--json"], { stdin: item });
    expect(first.code).toBe(0);
    expect(parseNdjson(first.stdout).find((o) => o.type === "result").sides[0]).toEqual({
      side: "debit",
      requested: "expense:sides-a",
      resolved: "expense:sides-a",
      how: "exact",
    });

    // expense:sides-a still exists, so re-resolving it would silently report "exact" again.
    const moved = await runCli([
      "transactions",
      "recategorize",
      "--filter-account",
      "expense:sides-a",
      "--set-account",
      "expense:sides-b",
      "--json",
    ]);
    expect(moved.code).toBe(0);
    expect(parseNdjson(moved.stdout)[0].affected).toBe(1);

    const second = await runCli(["ingest", "commit", "--file", "sf:dup-sides", "--json"], { stdin: item });
    expect(second.code).toBe(0);
    const result = parseNdjson(second.stdout).find((o) => o.type === "result");
    expect(result.duplicate).toBe(true);
    expect(result.sides).toEqual([
      {
        side: "debit",
        requested: "expense:sides-a",
        resolved: "expense:sides-b",
        how: "as_committed",
      },
      { side: "credit", requested: "asset:cash", resolved: "asset:cash", how: "as_committed" },
    ]);
  }, 45000);

  it("an ingested row carrying code:\"void\" still counts in balances (void is void_of-only, unreachable from ingest input)", async () => {
    const before = await runCli(["accounts", "show", "expense:food", "--json"]);
    const balanceBefore = parseNdjson(before.stdout)[0].balance as number;

    const description = "Statement extractor guessed code:void";
    const item = JSON.stringify({
      date: "2026-03-05",
      description,
      debit_account: "expense:food",
      credit_account: "asset:cash",
      amount: 42,
      code: "void",
    });

    const { code } = await runCli(["ingest", "commit", "--json"], { stdin: item });
    expect(code).toBe(0);

    const db = readDb();
    const row = db
      .prepare(`SELECT code, void_of FROM transactions WHERE description = ?`)
      .get(description) as { code: string | null; void_of: string | null };
    db.close();
    expect(row.code).toBe("void");
    expect(row.void_of).toBeNull();

    const after = await runCli(["accounts", "show", "expense:food", "--json"]);
    const balanceAfter = parseNdjson(after.stdout)[0].balance as number;
    expect(balanceAfter - balanceBefore).toBeCloseTo(42, 5);
  });

  it("commits a compound (linked) salary split under one shared group", async () => {
    const db = readDb();
    createAccount(db, { id: "asset:bank", name: "Bank", type: "asset", parent_id: "asset" });
    createAccount(db, { id: "income:salary", name: "Salary", type: "income", parent_id: "income" });
    createAccount(db, { id: "expense:tax", name: "Tax", type: "expense", parent_id: "expense" });
    db.close();

    const item = JSON.stringify({
      date: "2026-04-25",
      description: "Salary",
      linked: [
        { debit_account: "asset:bank", credit_account: "income:salary", amount: 4500, description: "Net pay" },
        { debit_account: "expense:tax", credit_account: "income:salary", amount: 500, description: "Withholding" },
      ],
    });

    const { stdout, code } = await runCli(["ingest", "commit", "--json"], { stdin: item });
    expect(code).toBe(0);

    const objs = parseNdjson(stdout);
    const r = objs.find((o) => o.type === "result");
    expect(r.ok).toBe(true);
    expect(r.group_id).toMatch(/^tg:/);
    expect(r.legs).toHaveLength(2);
    expect(r.legs.every((l: any) => /^tx:/.test(l.transaction_id))).toBe(true);
    expect(r.duplicate).toBe(false);

    const db2 = readDb();
    const rows = db2.prepare("SELECT id FROM transactions WHERE group_id = ?").all(r.group_id);
    db2.close();
    expect(rows).toHaveLength(2);
  }, 30000);

  it("rejects a cross-currency transaction with a currency_mismatch question", async () => {
    const db = readDb();
    createAccount(db, {
      id: "asset:usd",
      name: "USD Wallet",
      type: "asset",
      parent_id: "asset",
      currency: "USD",
    });
    db.close();

    const item = JSON.stringify({
      date: "2026-05-01",
      description: "FX move",
      debit_account: "expense:food",
      credit_account: "asset:usd",
      amount: 10,
    });

    const { stdout, code } = await runCli(["ingest", "commit", "--json"], { stdin: item });
    expect(code).toBe(7);

    const objs = parseNdjson(stdout);
    const r = objs.find((o) => o.type === "result");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("currency_mismatch");
    const summary = objs.find((o) => o.type === "summary");
    expect(summary.failed).toBe(1);

    const db2 = readDb();
    const q = db2.prepare("SELECT * FROM questions WHERE kind = 'currency_mismatch'").get();
    db2.close();
    expect(q).toBeTruthy();
  }, 30000);

  it("fails with USAGE when stdin has no transaction data", async () => {
    const { stdout, stderr, code } = await runCli(["ingest", "commit", "--json"], { stdin: "" });
    expect(code).toBe(2); // EXIT.USAGE
    expect(stdout.trim()).toBe("");
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.error.code).toBe("E_USAGE");
  }, 30000);
});

describe("ingest prepare (subprocess)", () => {
  it("extracts a PDF's own text layer into one document, resolving the rel_path `ingest list` emits", async () => {
    stage("statements/kbank-jan.pdf", textPdf());

    const list = await runCli(["ingest", "list", "--regex", "kbank-jan", "--json"], { cwd: sandbox.root });
    expect(list.code).toBe(0);
    const entry = parseNdjson(list.stdout).find((r) => r.type === "file");
    expect(entry).toBeTruthy();
    expect(entry.rel_path).toBe("statements/kbank-jan.pdf");

    const prepare = await runCli(["ingest", "prepare", entry.rel_path, "--json"], { cwd: sandbox.root });
    expect(prepare.code).toBe(0);
    const obj = JSON.parse(prepare.stdout.trim());
    expect(obj).toMatchObject({
      kind: "text",
      source: "text-layer",
      text_layer: "complete",
      page_count: 1,
    });
    expect(obj.document).toBe(join(sandbox.cacheDir, obj.file_id, "document.txt"));
    expect(readFileSync(obj.document, "utf8")).toContain("--- page 1 ---");
    expect(obj.failed_pages).toBeUndefined();
    expect(obj.ocr_model).toBeUndefined();
  }, 30000);

  it("hands an image back by its own path, writing nothing to the cache", async () => {
    const path = stage("receipts/receipt.png", samplePng());

    const { stdout, code } = await runCli(["ingest", "prepare", path, "--json"]);
    expect(code).toBe(0);
    const obj = JSON.parse(stdout.trim());
    expect(obj).toMatchObject({
      kind: "images",
      source: "original",
      text_layer: "none",
      page_count: 1,
      pages: [{ page: 1, path }],
    });
    expect(obj.dpi).toBeUndefined();
    expect(existsSync(join(sandbox.cacheDir, obj.file_id))).toBe(false);
  }, 30000);

  it("rasterizes to 1-based page PNGs when no OCR server is configured, with or without --rescan", async () => {
    const scan = stage("statements/scan.pdf", pdfOf(["image", "image"]));

    const { stdout, code } = await runCli(["ingest", "prepare", scan, "--json"]);
    expect(code).toBe(0);
    const obj = JSON.parse(stdout.trim());
    expect(obj).toMatchObject({
      kind: "images",
      source: "raster",
      text_layer: "none",
      dpi: 200,
      page_count: 2,
    });
    expect(obj.pages).toEqual([
      { page: 1, path: join(sandbox.cacheDir, obj.file_id, "p1.png") },
      { page: 2, path: join(sandbox.cacheDir, obj.file_id, "p2.png") },
    ]);
    expect(readFileSync(obj.pages[0].path).subarray(1, 4).toString("latin1")).toBe("PNG");

    const text = stage("statements/two-page.pdf", pdfOf(["text", "text"]));
    const rescanned = await runCli(["ingest", "prepare", text, "--rescan", "--no-ocr", "--json"]);
    expect(rescanned.code).toBe(0);
    expect(JSON.parse(rescanned.stdout.trim())).toMatchObject({
      kind: "images",
      source: "raster",
      text_layer: "none",
      page_count: 2,
    });
  }, 30000);

  it("maps a refusal to its exit code and hint: unreadable type USAGE, missing path NOT_FOUND", async () => {
    const path = stage("bucket/notes.docx", Buffer.from("PK"));

    const unsupported = await runCli(["ingest", "prepare", path, "--json"]);
    expect(unsupported.code).toBe(2); // EXIT.USAGE
    const { error } = JSON.parse(unsupported.stderr.trim());
    expect(error.code).toBe("E_USAGE");
    expect(error.hint).toContain(".pdf");

    const missing = await runCli(["ingest", "prepare", "no/such/statement.pdf", "--json"]);
    expect(missing.code).toBe(5); // EXIT.NOT_FOUND
    expect(JSON.parse(missing.stderr.trim()).error.code).toBe("E_NOT_FOUND");
  }, 30000);

  it("exits INPUT_REQUIRED for a locked PDF, then extracts it with --password", async () => {
    const path = stage("statements/locked.pdf", await encryptedPdf("secret"));

    const locked = await runCli(["ingest", "prepare", path, "--json"]);
    expect(locked.code).toBe(4); // EXIT.INPUT_REQUIRED
    const { error } = JSON.parse(locked.stderr.trim());
    expect(error.code).toBe("E_INPUT_REQUIRED");
    expect(error.hint).toContain("--password");

    const unlocked = await runCli(["ingest", "prepare", path, "--password", "secret", "--json"]);
    expect(unlocked.code).toBe(0);
    const obj = JSON.parse(unlocked.stdout.trim());
    expect(obj).toMatchObject({ kind: "text", source: "text-layer" });
    expect(existsSync(join(sandbox.cacheDir, obj.file_id, "document.pdf"))).toBe(false);
  }, 30000);

  it("--force keeps the prior ingest's transactions when the re-read fails", async () => {
    const path = stage("statements/force-locked.pdf", await encryptedPdf("secret"));

    // Registered by hash without unlocking it; the forced re-read below carries a
    // wrong password, so it must fail and leave the prior row and its transactions.
    const source = loadSource(path);
    if (!source.ok) throw new Error(source.message);
    const fileId = "sf:force-locked";
    const db = readDb();
    db.prepare(
      `INSERT INTO files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'pending')`,
    ).run(fileId, path, source.value.hash, source.value.mime);
    db.close();

    const commit = await runCli(["ingest", "commit", "--file", fileId, "--json"], {
      stdin: JSON.stringify({
        date: "2026-06-01",
        description: "Force survivor",
        debit_account: "expense:food",
        credit_account: "asset:cash",
        amount: 77,
      }),
    });
    expect(commit.code).toBe(0);
    const txId = parseNdjson(commit.stdout).find((o) => o.type === "result").transaction_id;

    const forced = await runCli(["ingest", "prepare", path, "--force", "--password", "nope", "--json"]);
    expect(forced.code).toBe(4); // EXIT.INPUT_REQUIRED

    // The files row survived too, or its deletion would have cascaded this transaction away.
    const list = await runCli(["transactions", "list", "--query", "Force survivor", "--json"]);
    expect(list.code).toBe(0);
    expect(parseNdjson(list.stdout).map((r) => r.id)).toContain(txId);
  }, 45000);
});

describe("ingest prepare against an OCR server (subprocess)", () => {
  it("exits NOT_READY rather than degrading to images when nothing is listening", async () => {
    // Two pages, so this doesn't hash-dedup onto the live case's one-page scan.
    const path = stage("statements/scan-dead.pdf", pdfOf(["image", "image"]));
    const { code, stderr } = await runCli(["ingest", "prepare", path, "--json"], {
      env: {
        ...sandbox.env,
        OLED_OCR_BASE_URL: DEAD_OCR_BASE_URL,
        OLED_OCR_MODEL: "test-ocr-model",
      },
    });
    expect(code).toBe(3); // EXIT.NOT_READY
    const { error } = JSON.parse(stderr.trim());
    expect(error.code).toBe("E_NOT_READY");
    expect(error.hint).toContain("--no-ocr");
  }, 30000);
});

describe.skipIf(!liveOcr)("ingest prepare against an OCR server (live OCR endpoint)", () => {
  it(
    "reads a scan through the configured endpoint and names the model",
    async () => {
      const path = stage("statements/scan-ocr.pdf", pdfOf(["image"]));

      const { stdout, code } = await runCli(["ingest", "prepare", path, "--json"], {
        env: liveOcrEnv(sandbox.env),
      });
      expect(code).toBe(0);
      const obj = JSON.parse(stdout.trim());
      expect(obj).toMatchObject({
        kind: "text",
        source: "ocr",
        ocr_model: requireLiveOcr().model,
        page_count: 1,
        failed_pages: [],
      });
      expect(readFileSync(obj.document, "utf8").startsWith("--- page 1 ---\n")).toBe(true);
    },
    240_000,
  );
});

describe("ingest list (subprocess)", () => {
  it("lists images, skips file types it cannot read, and reports an oversized file as unreadable", async () => {
    stage("bucket/receipt.png", samplePng());
    stage("bucket/notes.docx", Buffer.from("PK"));
    const huge = join(sandbox.dataDir, "bucket", "huge.pdf");
    closeSync(openSync(huge, "w"));
    truncateSync(huge, MAX_SOURCE_BYTES + 1024);

    const { stdout, code } = await runCli(["ingest", "list", "--regex", "^bucket/", "--json"]);
    expect(code).toBe(0);
    const objs = parseNdjson(stdout);
    const files = objs.filter((o) => o.type === "file");
    expect(files.map((f) => f.rel_path).sort()).toEqual(["bucket/huge.pdf", "bucket/receipt.png"]);

    const oversized = files.find((f) => f.rel_path === "bucket/huge.pdf");
    expect(oversized.status).toBe("unreadable");
    expect(oversized.note).toBeTruthy();
    expect(objs.find((o) => o.type === "summary").unreadable).toBe(1);
  }, 30000);
});

describe("ingest fail (subprocess)", () => {
  it("purges the file's raster cache and reports cache_removed", async () => {
    const fileId = "sf:cache-test";
    const db = readDb();
    try {
      db.prepare(
        `INSERT INTO files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'pending')`,
      ).run(fileId, "/tmp/cache-test.pdf", "cache-test-hash", "application/pdf");
    } finally {
      db.close();
    }

    // Precreate the cache subdir the subprocess would otherwise leave behind, so there's something real to remove.
    const cacheSubdir = join(sandbox.cacheDir, fileId);
    mkdirSync(cacheSubdir, { recursive: true });
    writeFileSync(join(cacheSubdir, "page-1.png"), "fake png bytes");
    expect(existsSync(cacheSubdir)).toBe(true);

    const { stdout, code } = await runCli([
      "ingest",
      "fail",
      fileId,
      "--error",
      "unreadable statement",
      "--json",
    ]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.status).toBe("failed");
    expect(result.cache_removed).toEqual([cacheSubdir]);
    expect(existsSync(cacheSubdir)).toBe(false);
  }, 30000);
});
