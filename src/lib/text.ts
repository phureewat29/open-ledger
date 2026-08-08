/** Decodes user-authored text (config.json, context.md, stdin/--input rows).
 *  PowerShell 5.1's `>` redirect writes UTF-16LE and Windows editors prepend
 *  BOMs, so the BOM picks the decode and the decoded U+FEFF is stripped. */
export function decodeUserText(bytes: Buffer): string {
  const text =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? bytes.subarray(2).toString("utf16le")
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? // Copied first: swap16 mutates, and the subarray aliases the caller's buffer.
          Buffer.from(bytes.subarray(2)).swap16().toString("utf16le")
        : bytes.toString("utf8");
  return text.replace(/^\uFEFF/, "");
}
