/**
 * A tiny, dependency-free markdown parser that renders `claude`'s final
 * answers terminal-native instead of dumping raw markdown (`##`, `**`, pipe
 * tables) into the UI.
 *
 * Not a full CommonMark implementation - it covers what the agent's answers
 * actually contain (headings, bullet/numbered lists, GitHub pipe tables,
 * fenced code, bold/italic/inline-code/link marks) and degrades anything else
 * to a plain paragraph rather than throwing. ui.tsx turns these blocks into
 * styled <Text>; renderPlain turns them into flat ASCII for piped output.
 */

/** One run of inline text carrying its (possibly empty) emphasis marks. */
export interface Segment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type Block =
  | { type: "heading"; level: number; segments: Segment[] }
  | { type: "bullet"; depth: number; segments: Segment[] }
  | { type: "numbered"; n: number; segments: Segment[] }
  | { type: "paragraph"; segments: Segment[] }
  | { type: "code"; lines: string[] }
  /** `rows[0]` is the header row; the rest are body rows. Cells are plain text
   *  (inline marks flattened) since terminal tables don't restyle per cell. */
  | { type: "table"; rows: string[][] };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED_RE = /^(\s*)(\d+)\.\s+(.*)$/;
const FENCE_RE = /^\s*```/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

/** True for a GitHub table's `| --- | :--: |` separator row. */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|")) return false;
  return t
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

/** Split a pipe-table row into trimmed cells, dropping the outer pipes. */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => flattenInline(cell.trim()));
}

/** Parse inline emphasis/code/links into styled segments. Links `[t](url)`
 *  become the plain text `t (url)`; unmatched markers are left as literal text. */
export function parseInline(text: string): Segment[] {
  const linked = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => `${label} (${url})`);
  const segments: Segment[] = [];
  // Inline code first so `*` inside a code span isn't read as emphasis.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(linked)) !== null) {
    if (m.index > lastIndex) segments.push({ text: linked.slice(lastIndex, m.index) });
    if (m[1]) segments.push({ text: m[1].slice(1, -1), code: true });
    else if (m[2]) segments.push({ text: m[2].slice(2, -2), bold: true });
    else if (m[3]) segments.push({ text: m[3].slice(1, -1), italic: true });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < linked.length) segments.push({ text: linked.slice(lastIndex) });
  return segments.length > 0 ? segments : [{ text: linked }];
}

/** Inline text with all marks flattened to plain characters. */
export function flattenInline(text: string): string {
  return parseInline(text)
    .map((s) => s.text)
    .join("");
}

/** The plain string for a segment list (used by renderPlain and table cells). */
export function segmentsToText(segments: Segment[]): string {
  return segments.map((s) => s.text).join("");
}

/**
 * Parse markdown source into a flat block list. Consecutive plain lines merge
 * into one paragraph; a blank line ends the current paragraph. Anything that
 * looks like a table but lacks a valid separator row falls back to paragraph
 * text.
 */
export function parseMarkdown(input: string): Block[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", segments: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      flushParagraph();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) code.push(lines[i++]);
      blocks.push({ type: "code", lines: code });
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    // A table needs a header row immediately followed by a separator row;
    // otherwise the "|" line is just ordinary paragraph text.
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      const rows: string[][] = [splitTableRow(line)];
      i += 2; // consume header + separator
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) rows.push(splitTableRow(lines[i++]));
      i--; // step back so the for-loop's i++ lands on the next unconsumed line
      blocks.push({ type: "table", rows });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1].length, segments: parseInline(heading[2]) });
      continue;
    }

    const numbered = NUMBERED_RE.exec(line);
    if (numbered) {
      flushParagraph();
      blocks.push({ type: "numbered", n: Number(numbered[2]), segments: parseInline(numbered[3]) });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushParagraph();
      const depth = Math.floor(bullet[1].replace(/\t/g, "  ").length / 2);
      blocks.push({ type: "bullet", depth, segments: parseInline(bullet[2]) });
      continue;
    }

    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

/** Pad each column of a table to its widest cell, returning aligned rows. Shared
 *  by the plain renderer and the ink TTY table (a dependency-free padded grid). */
export function padTable(rows: string[][]): string[][] {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) widths[c] = Math.max(0, ...rows.map((r) => (r[c] ?? "").length));
  return rows.map((r) => r.map((cell, c) => (cell ?? "").padEnd(widths[c])));
}

/**
 * Render parsed blocks to flat ASCII for piped/non-TTY output: headings without
 * `#`, emphasis stripped, tables as space-padded columns with a dashed rule
 * under the header. Blocks are separated by single blank lines.
 */
export function renderPlain(blocks: Block[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        out.push(segmentsToText(block.segments));
        break;
      case "bullet":
        out.push(`${"  ".repeat(block.depth)}- ${segmentsToText(block.segments)}`);
        break;
      case "numbered":
        out.push(`${block.n}. ${segmentsToText(block.segments)}`);
        break;
      case "paragraph":
        out.push(segmentsToText(block.segments));
        break;
      case "code":
        for (const line of block.lines) out.push(`    ${line}`);
        break;
      case "table": {
        const padded = padTable(block.rows);
        if (padded.length > 0) {
          out.push(padded[0].join("  ").trimEnd());
          out.push(padded[0].map((cell) => "-".repeat(cell.length)).join("  ").trimEnd());
          for (const row of padded.slice(1)) out.push(row.join("  ").trimEnd());
        }
        break;
      }
    }
  }
  return out.join("\n");
}
