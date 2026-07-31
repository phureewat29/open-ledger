import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type Database from "libsql";
import { config } from "../config.js";
import { createAccount } from "../accounts/accounts.js";
import { upsertMerchant } from "../db/queries/merchants.js";
import { insertTransaction, countTransactionsBySourceFile } from "../db/queries/transactions.js";
import { findFileById } from "../db/queries/files.js";
import { PAGE_RENDER } from "../extract/extract.js";
import { MAX_SOURCE_BYTES, loadSource, type LoadedSource } from "../extract/source.js";
import {
  corruptPdf,
  encryptedPdf,
  mixedPdf,
  scanPdf,
  textPdf,
} from "../../fixtures/pdf.js";
import { samplePng } from "../../fixtures/images.js";
import { freshDb } from "../../fixtures/db.js";
import {
  DEAD_OCR_BASE_URL,
  LIVE_PAGE_TIMEOUT_MS,
  liveOcr,
  requireLiveOcr,
  requireLiveOcrSource,
} from "../../fixtures/ocr-endpoint.js";
import {
  cleanCache,
  discoverFiles,
  prepareFile,
  registerPendingFile,
  resolveEntryPath,
} from "./prepare.js";

let dataDir: string;
let cacheDir: string;
let outsideDir: string; // outside the data dir, for the cwd-relative resolution case
const png = samplePng();

beforeEach(() => {
  dataDir = mkdtempSync(resolve(tmpdir(), "oled-ingest-data-"));
  cacheDir = mkdtempSync(resolve(tmpdir(), "oled-ingest-cache-"));
  outsideDir = mkdtempSync(resolve(tmpdir(), "oled-ingest-outside-"));
  config.dataDir = dataDir;
  // A developer's own OLED_OCR_* env would otherwise route these tests at a live endpoint.
  config.ocrBaseUrl = "";
  config.ocrModel = "";
  config.ocrApiKey = "";
  process.env.OLED_CACHE_DIR = cacheDir;
});

afterEach(() => {
  for (const dir of [dataDir, cacheDir, outsideDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.OLED_CACHE_DIR;
});

function write(name: string, bytes: Buffer): string {
  const path = resolve(dataDir, name);
  writeFileSync(path, bytes);
  return path;
}

function loaded(path: string): LoadedSource {
  const source = loadSource(path);
  if (!source.ok) throw new Error(`fixture is not loadable: ${source.message}`);
  return source.value;
}

describe("discoverFiles", () => {
  it("walks recursively, dedups by hash, and flags known files", async () => {
    const db = freshDb();
    write("a.pdf", textPdf());
    mkdirSync(resolve(dataDir, "sub"), { recursive: true });
    write("sub/b.pdf", textPdf());

    const first = await discoverFiles(db);
    expect(first).toHaveLength(2);
    expect(first.every((e) => e.status === "new" && e.fileId === null)).toBe(true);
    expect(first.every((e) => !e.encrypted)).toBe(true);
    expect(first.map((e) => e.relPath).sort()).toEqual(["a.pdf", "sub/b.pdf"]);

    const target = first.find((e) => e.relPath === "a.pdf")!;
    const { fileId } = registerPendingFile(db, loaded(target.path));

    const second = await discoverFiles(db);
    const known = second.find((e) => e.relPath === "a.pdf")!;
    expect(known.status).toBe("pending");
    expect(known.fileId).toBe(fileId);
  });

  it("filters by regex against the relative path", async () => {
    const db = freshDb();
    write("a.pdf", textPdf());
    mkdirSync(resolve(dataDir, "sub"), { recursive: true });
    write("sub/b.pdf", textPdf());

    const entries = await discoverFiles(db, { regex: /^sub\// });
    expect(entries.map((e) => e.relPath)).toEqual(["sub/b.pdf"]);
  });

  it("lists images alongside PDFs and ignores extensions it cannot read", async () => {
    const db = freshDb();
    write("statement.pdf", textPdf());
    write("receipt.png", png);
    write("notes.docx", Buffer.from("PK"));

    const entries = await discoverFiles(db);
    expect(entries.map((e) => e.relPath).sort()).toEqual(["receipt.png", "statement.pdf"]);
  });

  it("reports an oversized file as unreadable instead of sinking the walk", async () => {
    const db = freshDb();
    write("small.pdf", textPdf());
    const huge = resolve(dataDir, "huge.pdf");
    closeSync(openSync(huge, "w"));
    truncateSync(huge, MAX_SOURCE_BYTES + 1024);

    const entries = await discoverFiles(db);
    const big = entries.find((e) => e.relPath === "huge.pdf")!;
    expect(big).toMatchObject({ status: "unreadable", hash: null, fileId: null });
    expect(big.note).toContain(String(MAX_SOURCE_BYTES));
    expect(entries.find((e) => e.relPath === "small.pdf")!.status).toBe("new");
  });

  it("reports a PDF it cannot open as unreadable, naming the reason", async () => {
    const db = freshDb();
    write("broken.pdf", corruptPdf());

    const [entry] = await discoverFiles(db);
    expect(entry.status).toBe("unreadable");
    expect(entry.note).toBeTruthy();
  });

  it("reports encryption and never probes an image", async () => {
    const db = freshDb();
    write("kbank.pdf", await encryptedPdf("secret"));
    write("kbank.png", png);

    const entries = await discoverFiles(db);
    expect(entries.find((e) => e.relPath === "kbank.pdf")).toMatchObject({ encrypted: true });
    expect(entries.find((e) => e.relPath === "kbank.png")).toMatchObject({ encrypted: false });
  });
});

describe("registerPendingFile", () => {
  it("inserts a pending row and dedups on re-register", () => {
    const db = freshDb();
    const source = loaded(write("a.pdf", textPdf()));

    const first = registerPendingFile(db, source);
    expect(first.alreadyKnown).toBe(false);
    expect(first.fileId.startsWith("sf:")).toBe(true);
    expect(findFileById(db, first.fileId)?.status).toBe("pending");

    const second = registerPendingFile(db, source);
    expect(second).toEqual({ fileId: first.fileId, alreadyKnown: true });
  });

  it("records the real mime, so an image is not filed as a PDF", () => {
    const db = freshDb();
    const { fileId } = registerPendingFile(db, loaded(write("receipt.png", png)));
    expect(findFileById(db, fileId)?.mime).toBe("image/png");
  });
});

describe("resolveEntryPath", () => {
  it("resolves a rel_path (as emitted by `ingest list`) relative to the data dir, regardless of cwd", () => {
    const db = freshDb();
    mkdirSync(resolve(dataDir, "sub"), { recursive: true });
    const path = write("sub/b.pdf", textPdf());

    const elsewhere = mkdtempSync(resolve(tmpdir(), "oled-ingest-elsewhere-"));
    const prevCwd = process.cwd();
    process.chdir(elsewhere);
    try {
      expect(resolveEntryPath(db, "sub/b.pdf")).toBe(path);
    } finally {
      process.chdir(prevCwd);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("still resolves an absolute path", () => {
    const db = freshDb();
    const path = write("a.pdf", textPdf());
    expect(resolveEntryPath(db, path)).toBe(path);
  });

  it("still resolves a cwd-relative path when it isn't rooted under the data dir", () => {
    const db = freshDb();
    writeFileSync(resolve(outsideDir, "c.pdf"), textPdf());
    const prevCwd = process.cwd();
    process.chdir(outsideDir);
    try {
      // Compare against process.cwd(), not the pre-chdir string: macOS tmpdir is a
      // symlink that chdir resolves to its real path.
      expect(resolveEntryPath(db, "c.pdf")).toBe(resolve(process.cwd(), "c.pdf"));
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("still resolves a sf: file id", () => {
    const db = freshDb();
    const path = write("a.pdf", textPdf());
    const { fileId } = registerPendingFile(db, loaded(path));
    expect(resolveEntryPath(db, fileId)).toBe(path);
  });

  it("returns null for a path or id that matches nothing", () => {
    const db = freshDb();
    expect(resolveEntryPath(db, "sf:does-not-exist")).toBeNull();
    expect(resolveEntryPath(db, "no/such/file.pdf")).toBeNull();
  });
});

describe("prepareFile: text route", () => {
  it("writes one document.txt (0600, in a 0700 dir) with a marker per page", async () => {
    const db = freshDb();
    const path = write("a.pdf", mixedPdf());

    const outcome = await prepareFile(db, path);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== "text") return;

    expect(outcome).toMatchObject({
      kind: "text",
      source: "text-layer",
      textLayer: "partial",
      pageCount: 3,
      failedPages: [],
    });
    expect(outcome.document).toBe(resolve(cacheDir, outcome.fileId, "document.txt"));
    expect(statSync(outcome.document).mode & 0o777).toBe(0o600);
    expect(statSync(resolve(cacheDir, outcome.fileId)).mode & 0o777).toBe(0o700);

    const text = readFileSync(outcome.document, "utf8");
    expect(text).toContain("--- page 1 ---");
    expect(text).toContain("--- page 3 ---");
    expect(text).toContain("1234.56 THB DEBIT ACME");
    expect(outcome.pages[0]).toEqual({ page: 1, chars: expect.any(Number) });
    expect(outcome.pages[0].chars).toBeGreaterThan(0);
  });

  it("resolves a file id as readily as a path", async () => {
    const db = freshDb();
    const path = write("a.pdf", textPdf());
    const { fileId } = registerPendingFile(db, loaded(path));

    const outcome = await prepareFile(db, fileId);
    expect(outcome.ok && outcome.fileId).toBe(fileId);
  });

  it("extracts a locked PDF's text without ever writing the statement itself to disk", async () => {
    const db = freshDb();
    const path = write("kbank.pdf", await encryptedPdf("secret"));

    const outcome = await prepareFile(db, path, { password: "secret" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== "text") return;

    expect(readFileSync(outcome.document, "utf8")).toContain("--- page 1 ---");
    expect(readdirSync(resolve(cacheDir, outcome.fileId))).toEqual(["document.txt"]);
  });

  it("purges a prior run's artifacts before writing its own", async () => {
    const db = freshDb();
    const path = write("a.pdf", textPdf());

    const first = await prepareFile(db, path);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const dir = resolve(cacheDir, first.fileId);
    writeFileSync(resolve(dir, "p9.png"), "stale");

    const second = await prepareFile(db, path);
    expect(second.ok && second.fileId).toBe(first.fileId);
    expect(readdirSync(dir)).toEqual(["document.txt"]);
  });

});

describe("prepareFile: image route", () => {
  it("hands back an image by its own path, writing nothing", async () => {
    const db = freshDb();
    const path = write("receipt.png", png);

    const outcome = await prepareFile(db, path);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome).toMatchObject({
      kind: "images",
      source: "original",
      textLayer: "none",
      pageCount: 1,
      pages: [{ page: 1, path }],
    });
    expect(outcome.kind === "images" && outcome.dpi).toBeUndefined();
    expect(existsSync(resolve(cacheDir, outcome.fileId))).toBe(false);
  });

  it("rasterizes a scan to 1-based p{N}.png files (0600) when no endpoint is configured", async () => {
    const db = freshDb();
    const path = write("scan.pdf", scanPdf());

    const outcome = await prepareFile(db, path);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== "images") return;
    expect(outcome).toMatchObject({ source: "raster", textLayer: "none", dpi: PAGE_RENDER.dpi });
    expect(outcome.pages).toEqual([{ page: 1, path: resolve(cacheDir, outcome.fileId, "p1.png") }]);

    const bytes = readFileSync(outcome.pages[0].path);
    expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(statSync(outcome.pages[0].path).mode & 0o777).toBe(0o600);
  });

  it("--rescan ignores a good text layer and rasterizes instead", async () => {
    const db = freshDb();
    const path = write("a.pdf", textPdf());

    const outcome = await prepareFile(db, path, { rescan: true });
    expect(outcome.ok && outcome.kind).toBe("images");
    expect(outcome.ok && outcome.textLayer).toBe("none");
  });

});

describe("prepareFile: ocr route", () => {
  it("stays on the agent route when a model is set but no url is", async () => {
    const db = freshDb();
    const path = write("scan.pdf", scanPdf());
    config.ocrModel = "test-ocr-model";

    const outcome = await prepareFile(db, path);
    expect(outcome).toMatchObject({ ok: true, kind: "images", source: "raster" });
  });
});

describe.skipIf(!liveOcr)("prepareFile: ocr route (live OCR endpoint)", () => {
  it(
    "reads a scan through the endpoint, naming the model that read it",
    async () => {
      const db = freshDb();
      const path = write("scan.pdf", scanPdf());
      Object.assign(config, requireLiveOcrSource());

      const outcome = await prepareFile(db, path);
      // Named before the narrowing guard, so a silent fallback to the raster route can't pass this vacuously.
      expect(outcome.ok && outcome.kind).toBe("text");
      if (!outcome.ok || outcome.kind !== "text") return;
      expect(outcome).toMatchObject({
        source: "ocr",
        model: requireLiveOcr().model,
        failedPages: [],
      });
      expect(readFileSync(outcome.document, "utf8").startsWith("--- page 1 ---\n")).toBe(true);
    },
    LIVE_PAGE_TIMEOUT_MS,
  );

  it(
    "drops a prior run's document.txt when this run returns the image untouched",
    async () => {
      const db = freshDb();
      const path = write("receipt.png", png);
      Object.assign(config, requireLiveOcrSource());

      const first = await prepareFile(db, path);
      expect(first.ok && first.kind).toBe("text");
      if (!first.ok) return;
      expect(existsSync(resolve(cacheDir, first.fileId, "document.txt"))).toBe(true);

      const second = await prepareFile(db, path, { noOcr: true });
      expect(second.ok && second.source).toBe("original");
      expect(existsSync(resolve(cacheDir, first.fileId))).toBe(false);
    },
    LIVE_PAGE_TIMEOUT_MS,
  );
});

describe("prepareFile: refusals", () => {
  it("reports a missing path or id as not_found", async () => {
    const db = freshDb();
    const outcome = await prepareFile(db, "no/such/statement.pdf");
    expect(outcome).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("reports an extension it cannot read", async () => {
    const db = freshDb();
    const outcome = await prepareFile(db, write("notes.docx", Buffer.from("PK")));
    expect(outcome).toMatchObject({ ok: false, reason: "unsupported_extension" });
  });

  it("reports bytes that disagree with the extension", async () => {
    const db = freshDb();
    const outcome = await prepareFile(db, write("mislabeled.pdf", png));
    expect(outcome).toMatchObject({ ok: false, reason: "kind_mismatch" });
  });

  it("reports a PDF mupdf cannot open", async () => {
    const db = freshDb();
    const outcome = await prepareFile(db, write("broken.pdf", corruptPdf()));
    expect(outcome).toMatchObject({ ok: false, reason: "pdf_unreadable" });
  });

  it("reports password_required for a locked PDF with no password to try", async () => {
    const db = freshDb();
    const outcome = await prepareFile(db, write("kbank.pdf", await encryptedPdf("secret")));
    expect(outcome).toMatchObject({ ok: false, reason: "password_required" });
  });

  it("reports wrong_password for a password that does not open it", async () => {
    const db = freshDb();
    const path = write("kbank.pdf", await encryptedPdf("secret"));
    const outcome = await prepareFile(db, path, { password: "nope" });
    expect(outcome).toMatchObject({ ok: false, reason: "wrong_password" });
  });
});

describe("prepareFile: --force", () => {
  // A re-prepare needs something to lose.
  function commitRow(db: Database.Database, fileId: string): void {
    createAccount(db, { id: "thb:expense", name: "Expenses (THB)", type: "expense", parent_id: null });
    createAccount(db, { id: "thb:asset", name: "Assets (THB)", type: "asset", parent_id: null });
    const merchant = upsertMerchant(db, { canonical_name: "Shop" }, []);
    insertTransaction(db, {
      date: "2026-05-01",
      description: "Shop",
      merchant_id: merchant.id,
      source_file_id: fileId,
      debit_account_id: "thb:expense",
      credit_account_id: "thb:asset",
      amount: 1000,
    });
    expect(countTransactionsBySourceFile(db, fileId)).toBe(1);
  }

  it("re-registers the bytes, cascading away the prior ingest's transactions and artifacts", async () => {
    const db = freshDb();
    const path = write("scan.pdf", scanPdf());

    const first = await prepareFile(db, path);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const oldDir = resolve(cacheDir, first.fileId);
    expect(existsSync(oldDir)).toBe(true);
    commitRow(db, first.fileId);

    const second = await prepareFile(db, path, { force: true });
    expect(second.ok).toBe(true);
    if (!second.ok || second.kind !== "images") return;
    expect(second.fileId).not.toBe(first.fileId);
    expect(findFileById(db, first.fileId)).toBeNull();
    expect(countTransactionsBySourceFile(db, first.fileId)).toBe(0);
    expect(existsSync(oldDir)).toBe(false);
    expect(findFileById(db, second.fileId)?.status).toBe("pending");
    expect(existsSync(second.pages[0].path)).toBe(true);
  });

  it("keeps the prior row and its transactions when the password does not open it", async () => {
    const db = freshDb();
    const path = write("kbank.pdf", await encryptedPdf("secret"));
    // Registered by hash without ever unlocking it, so only the wrong password below is tried.
    const { fileId } = registerPendingFile(db, loaded(path));
    commitRow(db, fileId);

    const forced = await prepareFile(db, path, { force: true, password: "nope" });
    expect(forced).toMatchObject({ ok: false, reason: "wrong_password" });
    expect(findFileById(db, fileId)?.status).toBe("pending");
    expect(countTransactionsBySourceFile(db, fileId)).toBe(1);
  });

  it("keeps the prior row and its transactions when the OCR endpoint is dead", async () => {
    const db = freshDb();
    const path = write("scan.pdf", scanPdf());

    const first = await prepareFile(db, path);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    commitRow(db, first.fileId);

    config.ocrBaseUrl = DEAD_OCR_BASE_URL;
    config.ocrModel = "test-ocr-model";
    const forced = await prepareFile(db, path, { force: true });
    expect(forced).toMatchObject({ ok: false, reason: "ocr_unreachable" });
    expect(findFileById(db, first.fileId)?.status).toBe("pending");
    expect(countTransactionsBySourceFile(db, first.fileId)).toBe(1);
    expect(existsSync(resolve(cacheDir, first.fileId))).toBe(true);
  });
});

describe("cleanCache", () => {
  it("purges one file's subdir and then the whole cache", async () => {
    const db = freshDb();
    const path = write("scan.pdf", scanPdf());

    const one = await prepareFile(db, path);
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    const oneDir = resolve(cacheDir, one.fileId);
    expect(existsSync(oneDir)).toBe(true);

    expect(cleanCache(one.fileId).removed).toEqual([oneDir]);
    expect(existsSync(oneDir)).toBe(false);

    await prepareFile(db, path, { force: true });
    const removedAll = cleanCache();
    expect(removedAll.removed.length).toBeGreaterThan(0);
    expect(existsSync(cacheDir)).toBe(false);
  });
});
