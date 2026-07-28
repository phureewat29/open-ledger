import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SOURCE_BYTES, SUPPORTED_EXTS, loadSource, sniffSource } from "./source.js";
import { textPdf } from "../../fixtures/pdf.js";
import { samplePng } from "../../fixtures/images.js";

// Sniffing reads signatures only, so a header is a complete jpeg/webp here.
const jpegBytes = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const webpBytes = () => Buffer.from("RIFF\0\0\0\0WEBP", "latin1");

const dir = mkdtempSync(join(tmpdir(), "oled-source-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, bytes: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe("SUPPORTED_EXTS", () => {
  // The CLI quotes this list in its help text and hints.
  it("is the one pdf extension and four image extensions, in order", () => {
    expect(SUPPORTED_EXTS).toEqual([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);
  });
});

describe("sniffSource", () => {
  it("recognizes each accepted format from the real thing", () => {
    expect(sniffSource(textPdf())).toEqual({ kind: "pdf", mime: "application/pdf" });
    expect(sniffSource(samplePng())).toEqual({ kind: "image", mime: "image/png" });
    expect(sniffSource(jpegBytes())).toEqual({ kind: "image", mime: "image/jpeg" });
    expect(sniffSource(webpBytes())).toEqual({ kind: "image", mime: "image/webp" });
  });

  it("finds a PDF header that sits behind a preamble", () => {
    const padded = Buffer.concat([Buffer.alloc(300, 0x20), textPdf()]);
    expect(sniffSource(padded)).toEqual({ kind: "pdf", mime: "application/pdf" });
  });

  it("returns null for bytes it cannot place", () => {
    expect(sniffSource(Buffer.from("just some text"))).toBeNull();
    expect(sniffSource(Buffer.alloc(0))).toBeNull();
  });
});

describe("loadSource", () => {
  it("loads a PDF with its kind, mime, bytes and content hash", () => {
    const bytes = textPdf();
    const path = write("statement.pdf", bytes);

    const result = loadSource(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      path,
      fileName: "statement.pdf",
      kind: "pdf",
      mime: "application/pdf",
    });
    expect(result.value.bytes.equals(bytes)).toBe(true);
    expect(result.value.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("loads each image extension as kind image with the extension's mime", () => {
    const png = loadSource(write("receipt.png", samplePng()));
    expect(png.ok).toBe(true);
    if (!png.ok) return;
    expect(png.value).toMatchObject({ kind: "image", mime: "image/png" });
    expect(png.value.bytes.equals(samplePng())).toBe(true);

    expect(loadSource(write("a.jpg", jpegBytes()))).toMatchObject({
      ok: true,
      value: { kind: "image", mime: "image/jpeg" },
    });
    expect(loadSource(write("b.jpeg", jpegBytes()))).toMatchObject({
      ok: true,
      value: { kind: "image", mime: "image/jpeg" },
    });
    expect(loadSource(write("c.webp", webpBytes()))).toMatchObject({
      ok: true,
      value: { kind: "image", mime: "image/webp" },
    });
  });

  it("rejects an extension it does not handle", () => {
    const result = loadSource(write("notes.docx", Buffer.from("PK")));
    expect(result).toMatchObject({ ok: false, reason: "unsupported_extension" });
    if (!result.ok) expect(result.message).toContain(".docx");
  });

  it("rejects bytes that disagree with the extension, naming what it found", () => {
    const result = loadSource(write("mislabeled.pdf", samplePng()));
    expect(result).toMatchObject({ ok: false, reason: "kind_mismatch" });
    if (!result.ok) expect(result.message).toContain("image/png");
  });

  it("rejects a supported extension holding unrecognizable bytes", () => {
    const result = loadSource(write("empty.png", Buffer.alloc(0)));
    expect(result).toMatchObject({ ok: false, reason: "kind_mismatch" });
    if (!result.ok) expect(result.message).toContain("unrecognized");
  });

  it("rejects a file over the size cap without reading it", () => {
    const path = join(dir, "huge.pdf");
    closeSync(openSync(path, "w"));
    truncateSync(path, MAX_SOURCE_BYTES + 1024 * 1024);

    const result = loadSource(path);
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
    if (!result.ok) expect(result.message).toContain(String(MAX_SOURCE_BYTES));
  });

  it("reports a missing file as unreadable", () => {
    const result = loadSource(join(dir, "nope.pdf"));
    expect(result).toMatchObject({ ok: false, reason: "unreadable" });
    if (!result.ok) expect(result.message).toContain("ENOENT");
  });
});
