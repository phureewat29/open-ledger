import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { generateKey } from "../db/encryption.js";
import { config } from "../config.js";
import { createAccount } from "../accounts/accounts.js";
import { upsertMerchant } from "../db/queries/merchants.js";
import { insertTransaction, countTransactionsBySourceFile } from "../db/queries/transactions.js";
import { findFileById } from "../db/queries/files.js";
import { savePassword } from "./pdf.js";
import {
  discoverFiles,
  registerPendingFile,
  prepareFile,
  resolveEntryPath,
  cleanCache,
  PasswordRequiredError,
} from "./prepare.js";

function minimalPdf(): Buffer {
  const header = "%PDF-1.4\n";
  const o1 = "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n";
  const o2 = "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n";
  const o3 =
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\n";
  const offset1 = header.length;
  const offset2 = offset1 + o1.length;
  const offset3 = offset2 + o2.length;
  const xrefStart = offset3 + o3.length;
  const xref =
    `xref\n0 4\n` +
    `0000000000 65535 f \n` +
    `${String(offset1).padStart(10, "0")} 00000 n \n` +
    `${String(offset2).padStart(10, "0")} 00000 n \n` +
    `${String(offset3).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer<</Size 4/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(header + o1 + o2 + o3 + xref + trailer, "latin1");
}

async function encryptedPdf(password: string): Promise<Buffer> {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(minimalPdf(), "application/pdf");
  try {
    const out = doc.saveToBuffer(
      `encrypt=aes-256,user-password=${password},owner-password=${password}`,
    );
    return Buffer.from(out.asUint8Array());
  } finally {
    doc.destroy();
  }
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

let dataDir: string;
let cacheDir: string;
let outDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(resolve(tmpdir(), "oled-ingest-data-"));
  cacheDir = mkdtempSync(resolve(tmpdir(), "oled-ingest-cache-"));
  outDir = mkdtempSync(resolve(tmpdir(), "oled-ingest-out-"));
  config.dataDir = dataDir;
  config.dbEncryptionKey = generateKey();
  process.env.OLED_CACHE_DIR = cacheDir;
});

afterEach(() => {
  for (const dir of [dataDir, cacheDir, outDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.OLED_CACHE_DIR;
});

describe("discoverFiles", () => {
  it("walks recursively, dedups by hash, and flags known files", async () => {
    const db = freshDb();
    writeFileSync(resolve(dataDir, "a.pdf"), minimalPdf());
    mkdirSync(resolve(dataDir, "sub"), { recursive: true });
    writeFileSync(resolve(dataDir, "sub", "b.pdf"), minimalPdf());

    const first = await discoverFiles(db);
    expect(first).toHaveLength(2);
    expect(first.every((e) => e.status === "new" && e.fileId === null)).toBe(true);
    expect(first.every((e) => !e.encrypted && e.vaultCandidates === 0)).toBe(true);
    expect(first.map((e) => e.relPath).sort()).toEqual(["a.pdf", "sub/b.pdf"]);

    const target = first.find((e) => e.relPath === "a.pdf")!;
    const { fileId } = registerPendingFile(db, target.path);

    const second = await discoverFiles(db);
    const known = second.find((e) => e.relPath === "a.pdf")!;
    expect(known.status).toBe("pending");
    expect(known.fileId).toBe(fileId);
  });

  it("filters by regex against the relative path", async () => {
    const db = freshDb();
    writeFileSync(resolve(dataDir, "a.pdf"), minimalPdf());
    mkdirSync(resolve(dataDir, "sub"), { recursive: true });
    writeFileSync(resolve(dataDir, "sub", "b.pdf"), minimalPdf());

    const entries = await discoverFiles(db, { regex: /^sub\// });
    expect(entries.map((e) => e.relPath)).toEqual(["sub/b.pdf"]);
  });

  it("reports encryption and matching vault candidates", async () => {
    const db = freshDb();
    writeFileSync(resolve(dataDir, "kbank.pdf"), await encryptedPdf("secret"));
    savePassword(db, "^kbank.*", "secret", config.dbEncryptionKey);

    const [entry] = await discoverFiles(db);
    expect(entry.encrypted).toBe(true);
    expect(entry.vaultCandidates).toBe(1);
  });
});

describe("registerPendingFile", () => {
  it("inserts a pending row and dedups on re-register", () => {
    const db = freshDb();
    const path = resolve(dataDir, "a.pdf");
    writeFileSync(path, minimalPdf());

    const first = registerPendingFile(db, path);
    expect(first.alreadyKnown).toBe(false);
    expect(first.fileId.startsWith("sf:")).toBe(true);
    expect(findFileById(db, first.fileId)?.status).toBe("pending");

    const second = registerPendingFile(db, path);
    expect(second).toEqual({ fileId: first.fileId, alreadyKnown: true });
  });
});

describe("resolveEntryPath", () => {
  it("resolves a rel_path (as emitted by `ingest list`) relative to the data dir, regardless of cwd", () => {
    const db = freshDb();
    mkdirSync(resolve(dataDir, "sub"), { recursive: true });
    const path = resolve(dataDir, "sub", "b.pdf");
    writeFileSync(path, minimalPdf());

    // cwd is somewhere else entirely (an agent's shell rarely sits in the
    // data dir) — this is the exact failure a live agent session hit.
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
    const path = resolve(dataDir, "a.pdf");
    writeFileSync(path, minimalPdf());
    expect(resolveEntryPath(db, path)).toBe(path);
  });

  it("still resolves a cwd-relative path when it isn't rooted under the data dir", () => {
    const db = freshDb();
    const path = resolve(outDir, "c.pdf");
    writeFileSync(path, minimalPdf());
    const prevCwd = process.cwd();
    process.chdir(outDir);
    try {
      /**
       * Compare against process.cwd(), not the pre-chdir `outDir` string — on macOS the tmp
       * dir is itself a symlink, so chdir resolves it to its real path (`/private/var/...` vs `/var/...`).
       */
      expect(resolveEntryPath(db, "c.pdf")).toBe(resolve(process.cwd(), "c.pdf"));
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("still resolves a sf: file id", () => {
    const db = freshDb();
    const path = resolve(dataDir, "a.pdf");
    writeFileSync(path, minimalPdf());
    const { fileId } = registerPendingFile(db, path);
    expect(resolveEntryPath(db, fileId)).toBe(path);
  });

  it("returns null for a path or id that matches nothing", () => {
    const db = freshDb();
    expect(resolveEntryPath(db, "sf:does-not-exist")).toBeNull();
    expect(resolveEntryPath(db, "no/such/file.pdf")).toBeNull();
  });
});

describe("prepareFile", () => {
  it("rasterizes requested pages to PNGs (resolving a fileId)", async () => {
    const db = freshDb();
    const path = resolve(dataDir, "a.pdf");
    writeFileSync(path, minimalPdf());
    const { fileId } = registerPendingFile(db, path);

    const result = await prepareFile(db, fileId, {
      format: "png",
      pages: [0],
      dpi: 72,
      outDir,
    });
    expect(result.format).toBe("png");
    expect(result.pageCount).toBe(1);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].page).toBe(0);
    expect(result.pages[0].path).toBe(resolve(outDir, "p0.png"));

    const png = readFileSync(result.pages[0].path);
    expect(png[0]).toBe(0x89);
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  it("defaults to every page when none are requested (png fallback)", async () => {
    const db = freshDb();
    const path = resolve(dataDir, "a.pdf");
    writeFileSync(path, minimalPdf());

    const result = await prepareFile(db, path, { format: "png", dpi: 72, outDir });
    expect(result.pages.map((p) => p.page)).toEqual([0]);
  });

  it("defaults to pdf format when none is specified", async () => {
    const db = freshDb();
    const path = resolve(dataDir, "a.pdf");
    writeFileSync(path, minimalPdf());

    const result = await prepareFile(db, path, { outDir });
    expect(result.format).toBe("pdf");
  });

  it("returns the original data-dir path as the document for a non-encrypted pdf, writing nothing to the cache", async () => {
    const db = freshDb();
    const path = resolve(dataDir, "a.pdf");
    writeFileSync(path, minimalPdf());

    const result = await prepareFile(db, path, { format: "pdf", outDir });
    expect(result.format).toBe("pdf");
    expect(result.document).toBe(path);
    expect(result.pages).toEqual([{ page: 0, path }]);
    // Nothing was written under either the explicit outDir or the fileId's cache dir.
    expect(readdirSync(outDir)).toEqual([]);
    expect(existsSync(resolve(cacheDir, result.fileId))).toBe(false);
  });

  it("writes a decrypted document.pdf (mode 0600) to the cache dir for an encrypted pdf, purged by cleanCache", async () => {
    const db = freshDb();
    const path = resolve(dataDir, "kbank.pdf");
    writeFileSync(path, await encryptedPdf("secret"));

    // No outDir -> lands under getCacheDir()/<fileId>, like the png fallback.
    const result = await prepareFile(db, path, { format: "pdf", password: "secret" });
    const expectedDir = resolve(cacheDir, result.fileId);
    expect(result.format).toBe("pdf");
    expect(result.document).toBe(resolve(expectedDir, "document.pdf"));
    expect(result.pages).toEqual([{ page: 0, path: result.document }]);
    expect(readFileSync(result.document!).subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(statSync(result.document!).mode & 0o777).toBe(0o600);

    const removed = cleanCache(result.fileId);
    expect(removed.removed).toEqual([expectedDir]);
    expect(existsSync(result.document!)).toBe(false);
  });

  it("force re-registers and cascades away the prior ingest's transactions", async () => {
    const db = freshDb();
    const path = resolve(dataDir, "a.pdf");
    writeFileSync(path, minimalPdf());
    createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });

    const { fileId: oldId } = registerPendingFile(db, path);
    const merchant = upsertMerchant(db, { canonical_name: "Shop" });
    insertTransaction(db, {
      date: "2026-05-01",
      description: "Shop",
      merchant_id: merchant.id,
      source_file_id: oldId,
      debit_account_id: "expense",
      credit_account_id: "asset",
      amount: 1000,
      currency: "THB",
    });
    expect(countTransactionsBySourceFile(db, oldId)).toBe(1);

    const result = await prepareFile(db, path, { force: true, dpi: 72, outDir });
    expect(result.fileId).not.toBe(oldId);
    expect(findFileById(db, oldId)).toBeNull();
    expect(countTransactionsBySourceFile(db, oldId)).toBe(0);
  });

  it("throws password_required for an encrypted PDF with no password", async () => {
    const db = freshDb();
    const path = resolve(dataDir, "kbank.pdf");
    writeFileSync(path, await encryptedPdf("secret"));

    await expect(prepareFile(db, path, { outDir })).rejects.toMatchObject({
      name: "PasswordRequiredError",
      reason: "password_required",
    });
  });

  it("unlocks an encrypted PDF with the supplied password (png fallback still rasterizes)", async () => {
    const db = freshDb();
    const path = resolve(dataDir, "kbank.pdf");
    writeFileSync(path, await encryptedPdf("secret"));

    const result = await prepareFile(db, path, {
      format: "png",
      password: "secret",
      dpi: 72,
      outDir,
    });
    expect(result.format).toBe("png");
    expect(result.pageCount).toBe(1);
    expect(existsSync(result.pages[0].path)).toBe(true);
  });
});

describe("cleanCache", () => {
  it("purges one file's subdir and then the whole cache", async () => {
    const db = freshDb();
    const path = resolve(dataDir, "a.pdf");
    writeFileSync(path, minimalPdf());

    /**
     * No outDir -> lands under getCacheDir()/<fileId> (redirected to tmp). format:"png" so a
     * cache write actually happens (pdf's default is a no-write passthrough — see prepareFile tests).
     */
    const one = await prepareFile(db, path, { format: "png", dpi: 72 });
    const oneDir = resolve(cacheDir, one.fileId);
    expect(existsSync(oneDir)).toBe(true);

    const removedOne = cleanCache(one.fileId);
    expect(removedOne.removed).toEqual([oneDir]);
    expect(existsSync(oneDir)).toBe(false);

    await prepareFile(db, path, { format: "png", dpi: 72, force: true });
    const removedAll = cleanCache();
    expect(removedAll.removed.length).toBeGreaterThan(0);
    expect(existsSync(cacheDir)).toBe(false);
  });
});
