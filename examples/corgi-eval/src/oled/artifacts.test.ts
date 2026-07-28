import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactsOf } from "./artifacts.js";

/**
 * The two payloads are `ingest prepare --json` verbatim, paths shortened. A
 * schema that drifts from them attaches nothing and says nothing, which is the
 * failure this file exists to catch.
 */

const TEXT_ROUTE = JSON.stringify({
  file_id: "sf:dde202a2",
  kind: "text",
  source: "text-layer",
  text_layer: "complete",
  page_count: 2,
  document: "/cache/sf:dde202a2/document.txt",
  pages: [
    { page: 1, chars: 1985 },
    { page: 2, chars: 1976 },
  ],
});

const OCR_ROUTE = JSON.stringify({
  file_id: "sf:dde202a2",
  kind: "text",
  source: "ocr",
  text_layer: "none",
  ocr_model: "some-model",
  page_count: 2,
  document: "/cache/sf:dde202a2/document.txt",
  pages: [
    { page: 1, chars: 1985 },
    { page: 2, chars: 0 },
  ],
  failed_pages: [2],
});

const IMAGES_ROUTE = JSON.stringify({
  file_id: "sf:dde202a2",
  kind: "images",
  source: "raster",
  text_layer: "none",
  page_count: 2,
  dpi: 200,
  pages: [
    { page: 2, path: "/cache/sf:dde202a2/page-2.png" },
    { page: 1, path: "/cache/sf:dde202a2/page-1.png" },
  ],
});

test("the text route yields the document and no pages", () => {
  const scan = artifactsOf(`${TEXT_ROUTE}\n`);
  assert.ok(scan.ok);
  assert.deepEqual(scan.value, {
    document: "/cache/sf:dde202a2/document.txt",
    pages: [],
    failedPages: [],
  });
});

test("the OCR route carries the pages that came back as placeholders", () => {
  const scan = artifactsOf(OCR_ROUTE);
  assert.ok(scan.ok);
  assert.deepEqual(scan.value.failedPages, [2]);
});

test("the images route yields page images in page order with media types", () => {
  const scan = artifactsOf(IMAGES_ROUTE);
  assert.ok(scan.ok);
  assert.equal(scan.value.document, null);
  assert.deepEqual(scan.value.pages, [
    { path: "/cache/sf:dde202a2/page-1.png", mediaType: "image/png" },
    { path: "/cache/sf:dde202a2/page-2.png", mediaType: "image/png" },
  ]);
});

test("a prepare payload the host cannot read is reported, never silent", () => {
  const drifted = JSON.stringify({
    file_id: "sf:dde202a2",
    kind: "text",
    page_count: 2,
    pages: [{ page: 1, path: "/cache/page-1.png" }],
  });
  const scan = artifactsOf(drifted);
  assert.equal(scan.ok, false);
  assert.equal(scan.ok === false && scan.reason, "unreadable");
});

test("output from any other command is absent, not unreadable", () => {
  const rows = [
    JSON.stringify({ id: "cn:1", kind: "dirty_input", prompt: "which account?" }),
    JSON.stringify({ file_id: "sf:dde202a2", status: "ingested", cache_removed: [] }),
    "Usage: oled ingest prepare [options] <pathOrId>",
    "",
  ].join("\n");
  const scan = artifactsOf(rows);
  assert.equal(scan.ok === false && scan.reason, "absent");
});
