/**
 * Hand-assembled, latin1-encoded so xref offsets are byte counts, not
 * character counts. Nothing here imports src/, except mupdf (only as the
 * writer `encryptedPdf` needs).
 */

export type PageKind = "text" | "blank" | "image";

function buildPdf(objects: string[]): Buffer {
  const header = "%PDF-1.4\n";
  const bodies = objects.map((body, index) => `${index + 1} 0 obj${body}endobj\n`);

  const offsets: number[] = [];
  let cursor = Buffer.byteLength(header, "latin1");
  for (const body of bodies) {
    offsets.push(cursor);
    cursor += Buffer.byteLength(body, "latin1");
  }

  const size = objects.length + 1;
  const xref =
    `xref\n0 ${size}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  const trailer = `trailer<</Size ${size}/Root 1 0 R>>\nstartxref\n${cursor}\n%%EOF\n`;

  return Buffer.from(header + bodies.join("") + xref + trailer, "latin1");
}

function streamObject(content: string): string {
  return `<</Length ${Buffer.byteLength(content, "latin1")}>>stream\n${content}\nendstream`;
}

// 20 lines clears the 400-char text-layer bar the way a real statement page does.
const TEXT_LINES = 20;

function textContent(page: number): string {
  let content = "BT /F1 11 Tf 36 756 Td 14 TL\n";
  for (let line = 0; line < TEXT_LINES; line++) {
    content += `(page${page} line ${String(line).padStart(2, "0")} 1234.56 THB DEBIT ACME) Tj T*\n`;
  }
  return `${content}ET\n`;
}

// An inline image (BI/ID/EI) with an ASCIIHex payload: a 2x2 bitmap stretched over the page, like a scanned page looks to the probe.
function imageContent(width: number, height: number): string {
  return (
    `q ${width} 0 0 ${height} 0 0 cm\n` +
    "BI /W 2 /H 2 /CS /RGB /BPC 8 /F /AHx ID\n" +
    "ff0000 00ff00 0000ff ffffff>\nEI Q\n"
  );
}

const CONTENT: Record<PageKind, (page: number) => string> = {
  text: (page) => textContent(page),
  blank: () => "\n",
  image: () => imageContent(WIDTH, HEIGHT),
};

// US Letter in points; the render tests read this size back out of the PNG they produce.
const WIDTH = 612;
const HEIGHT = 792;

/** One PDF per page-kind list: object 1 is the catalog, 2 the page tree, then page+content pairs, then the font. */
export function pdfOf(kinds: PageKind[]): Buffer {
  const firstPage = 3;
  const fontNumber = firstPage + kinds.length * 2;
  const kids = kinds.map((_, index) => `${firstPage + index * 2} 0 R`).join(" ");

  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    `<</Type/Pages/Kids[${kids}]/Count ${kinds.length}>>`,
  ];
  for (const [index, kind] of kinds.entries()) {
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${WIDTH} ${HEIGHT}]` +
        `/Resources<</Font<</F1 ${fontNumber} 0 R>>>>/Contents ${firstPage + index * 2 + 1} 0 R>>`,
    );
    objects.push(streamObject(CONTENT[kind](index + 1)));
  }
  objects.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");

  return buildPdf(objects);
}

export function textPdf(): Buffer {
  return pdfOf(["text"]);
}

export function scanPdf(): Buffer {
  return pdfOf(["image"]);
}

export function mixedPdf(): Buffer {
  return pdfOf(["text", "blank", "image"]);
}

/** Bytes mupdf refuses outright, for the pdf_unreadable arm. */
export function corruptPdf(): Buffer {
  return Buffer.from("%PDF-1.4\nnot really a pdf\n", "latin1");
}

export async function encryptedPdf(
  password: string,
  kinds: PageKind[] = ["text"],
): Promise<Buffer> {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(pdfOf(kinds), "application/pdf");
  try {
    // Encryption is a PDF-writer feature, so the fixture has to be a PDFDocument.
    if (!(doc instanceof mupdf.PDFDocument)) throw new Error("fixture is not a PDF document");
    const out = doc.saveToBuffer(
      `encrypt=aes-256,user-password=${password},owner-password=${password}`,
    );
    return Buffer.from(out.asUint8Array());
  } finally {
    doc.destroy();
  }
}

/** Width and height straight from the PNG IHDR chunk. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
