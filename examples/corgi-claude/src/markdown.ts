// Not a full CommonMark implementation; anything unrecognized degrades to a
// plain paragraph rather than throwing.

/** Inline marks are flattened at parse time: the only renderer is plain text. */
export type Block =
  | { type: "heading"; text: string }
  | { type: "bullet"; depth: number; text: string }
  | { type: "numbered"; n: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lines: string[] }
  | { type: "table"; rows: string[][] };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED_RE = /^(\s*)(\d+)\.\s+(.*)$/;
const FENCE_RE = /^\s*```/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

// One pass, code span first, so `**kwargs` inside backticks keeps its asterisks.
const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/g;

/** Drops the markers a terminal cannot show and rewrites `[t](url)` to `t (url)`;
 *  unmatched markers are left as literal text. */
function flattenInline(text: string): string {
  return text.replace(INLINE_RE, (_m, code, bold, italic, label, url) => {
    if (code !== undefined) return code;
    if (bold !== undefined) return bold;
    if (italic !== undefined) return italic;
    return `${label} (${url})`;
  });
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|")) return false;
  return t
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => flattenInline(cell.trim()));
}

/** Anything that looks like a table but lacks a valid separator row falls back to paragraph text. */
export function parseMarkdown(input: string): Block[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", text: flattenInline(paragraph.join(" ")) });
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

    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      const rows: string[][] = [splitTableRow(line)];
      i += 2;
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) rows.push(splitTableRow(lines[i++]));
      i--; // step back so the for-loop's i++ lands on the next unconsumed line
      blocks.push({ type: "table", rows });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", text: flattenInline(heading[2]) });
      continue;
    }

    const numbered = NUMBERED_RE.exec(line);
    if (numbered) {
      flushParagraph();
      blocks.push({ type: "numbered", n: Number(numbered[2]), text: flattenInline(numbered[3]) });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushParagraph();
      const depth = Math.floor(bullet[1].replace(/\t/g, "  ").length / 2);
      blocks.push({ type: "bullet", depth, text: flattenInline(bullet[2]) });
      continue;
    }

    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

function padTable(rows: string[][]): string[][] {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) widths[c] = Math.max(0, ...rows.map((r) => (r[c] ?? "").length));
  return rows.map((r) => r.map((cell, c) => (cell ?? "").padEnd(widths[c])));
}

/** Header row, an underline sized to it, then the body — no pipes. */
function renderTable(rows: string[][]): string[] {
  const padded = padTable(rows);
  if (padded.length === 0) return [];
  const [header, ...body] = padded;
  return [
    header.join("  ").trimEnd(),
    header.map((cell) => "-".repeat(cell.length)).join("  ").trimEnd(),
    ...body.map((row) => row.join("  ").trimEnd()),
  ];
}

const RENDER_BLOCK: {
  [K in Block["type"]]: (block: Extract<Block, { type: K }>) => string[];
} = {
  heading: (block) => [block.text],
  bullet: (block) => [`${"  ".repeat(block.depth)}- ${block.text}`],
  numbered: (block) => [`${block.n}. ${block.text}`],
  paragraph: (block) => [block.text],
  code: (block) => block.lines.map((line) => `    ${line}`),
  table: (block) => renderTable(block.rows),
};

export function renderPlain(blocks: Block[]): string {
  return blocks.flatMap((block) => RENDER_BLOCK[block.type](block as never)).join("\n");
}
