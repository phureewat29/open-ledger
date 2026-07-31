import { describe, it, expect } from "vitest";
import {
  classifyPage,
  readerFor,
  verdictOf,
  type OcrAvailability,
  type PageFacts,
  type Reader,
  type TextLayer,
} from "./route.js";

const ROUTES: [TextLayer, OcrAvailability, Reader][] = [
  ["complete", "ready", "text-layer"],
  ["complete", "unset", "text-layer"],
  ["partial", "ready", "ocr"],
  ["partial", "unset", "agent"],
  ["none", "ready", "ocr"],
  ["none", "unset", "agent"],
];

describe("readerFor", () => {
  for (const [textLayer, ocr, expected] of ROUTES) {
    it(`routes ${textLayer} text layer with ocr ${ocr} to ${expected}`, () => {
      expect(readerFor(textLayer, ocr)).toBe(expected);
    });
  }
});

const text: PageFacts = { chars: 2411, hasImage: false };
const scan: PageFacts = { chars: 0, hasImage: true };
const blank: PageFacts = { chars: 0, hasImage: false };

describe("classifyPage", () => {
  it("counts a page with enough characters as text, image or not", () => {
    expect(classifyPage({ chars: 400, hasImage: false })).toBe("text");
    expect(classifyPage({ chars: 400, hasImage: true })).toBe("text");
  });

  it("counts a thin text layer over an image as a scan", () => {
    expect(classifyPage({ chars: 399, hasImage: true })).toBe("scan");
  });

  it("counts a thin text layer with no image as blank", () => {
    expect(classifyPage({ chars: 399, hasImage: false })).toBe("blank");
  });
});

describe("verdictOf", () => {
  it("calls an all-text document complete", () => {
    expect(verdictOf([text, text])).toBe("complete");
  });

  it("lets a blank trailer page keep the document complete", () => {
    expect(verdictOf([text, text, blank])).toBe("complete");
  });

  it("calls a text document with one scanned page partial", () => {
    expect(verdictOf([text, blank, scan])).toBe("partial");
  });

  it("calls a document with no text page none, however it got there", () => {
    expect(verdictOf([scan, scan])).toBe("none");
    expect(verdictOf([blank])).toBe("none");
    expect(verdictOf([])).toBe("none");
  });
});
