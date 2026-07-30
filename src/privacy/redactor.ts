import { config } from "../config.js";
import { readContext } from "../context.js";

interface RedactionEntry {
  real: string;
  token: string;
}

interface SectionRule {
  heading: string;
  token: string;
  patterns: RegExp[];
  /** Trim a trailing parenthesised qualifier, e.g. "Corgi (partner)" becomes "Corgi". */
  stripParen?: boolean;
  skipIfUser?: boolean;
}

const SECTION_RULES: SectionRule[] = [
  {
    heading: "Family",
    token: "[PARTNER]",
    stripParen: true,
    skipIfUser: true,
    patterns: [
      /^(?:partner|spouse|wife|husband|child|kid|son|daughter|dependent)[:\s]+(.+)/i,
      /^([\p{Lu}\p{Lo}][\p{L}\s]+)/u,
    ],
  },
  {
    heading: "Income",
    token: "[EMPLOYER]",
    patterns: [
      /(?:employer|works? (?:at|for)|employed (?:at|by))[:\s]+([A-Z][\w\s&.,-]+?)(?:\s*[-–—|,;(\n]|$)/i,
      /\bfrom ([A-Z][A-Za-z\s&.,-]+?)(?:\s*[-–—|,;(\n]|$)/,
      /\bat ([A-Z][A-Za-z\s&.,-]+?)(?:\s*[-–—|,;(\n]|$)/,
    ],
  },
];

const NUMERIC_PII_PATTERNS: [RegExp, string][] = [
  // Thai national ID with dashes: 1-2345-67890-12-3
  [/\b\d-\d{4}-\d{5}-\d{2}-\d\b/g, "[NATID]"],
  // Thai national ID without dashes (13 digits): must precede the generic ACCT pattern.
  [/\b\d{13}\b/g, "[NATID]"],
  // Thai mobile numbers: 0[689]xxxxxxxx (10 digits starting 06/08/09)
  [/\b0[689]\d{8}\b/g, "[PHONE]"],
  // 16-digit credit card (with optional separators)
  [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[CARD]"],
  // 10-12 digit account / routing numbers at a word boundary
  [/\b\d{10,12}\b(?=\s|$|[,.])/g, "[ACCT]"],
];

function extractSectionLines(context: string, heading: string): string[] {
  const re = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n##|$)`);
  const match = context.match(re);
  if (!match) return [];
  return match[1]
    .split("\n")
    .filter((l) => l.trim().startsWith("-"))
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter((text) => text.length > 0 && !text.startsWith("("));
}

function applyRule(rule: SectionRule, context: string, userName: string, push: (real: string, token: string) => void) {
  for (const line of extractSectionLines(context, rule.heading)) {
    if (rule.skipIfUser && line.toLowerCase() === userName.toLowerCase()) continue;
    for (const pattern of rule.patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      let name = match[1].trim();
      if (rule.stripParen) name = name.replace(/\s*\(.*\)/, "").trim();
      if (!name) break;
      if (rule.skipIfUser && name.toLowerCase() === userName.toLowerCase()) break;
      push(name, rule.token);
      break;
    }
  }
}

function buildRedactions(): RedactionEntry[] {
  const entries: RedactionEntry[] = [];
  const seen = new Set<string>();

  const push = (real: string, token: string) => {
    const trimmed = real.trim();
    if (trimmed.length < 2) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ real: trimmed, token });
  };

  const userName = config.userName;
  if (userName && userName !== "User") {
    push(userName, "[USER]");
    const parts = userName.split(/\s+/);
    if (parts.length > 1) {
      push(parts[0], "[USER_FIRST]");
      push(parts[parts.length - 1], "[USER_LAST]");
    }
  }

  const context = readContext();
  if (context) {
    for (const rule of SECTION_RULES) {
      applyRule(rule, context, userName, push);
    }
  }

  entries.sort((a, b) => b.real.length - a.real.length);
  return entries;
}

/** Builds name rules from config.userName + context.md once, returning a reusable
 *  masker that amortizes that cost across many values. */
function createRedactor(): (text: string) => string {
  const redactions = buildRedactions();
  return (text: string): string => {
    let result = text;
    for (const { real, token } of redactions) {
      result = result.replaceAll(real, token);
    }
    for (const [pattern, replacement] of NUMERIC_PII_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  };
}

/**
 * Deep-walks `data`, redacting a string value only when its key is in the
 * per-command `fields` allowlist — ids/enums/amounts the agent needs verbatim
 * stay untouched. Returns a fresh structure (input untouched); a no-op when
 * `enabled` is false.
 */
export function applyRedaction<T>(data: T, enabled: boolean, fields: readonly string[]): T {
  if (!enabled) return data;
  const redactor = createRedactor();
  const allow = new Set(fields);

  const walk = (value: unknown, key: string | undefined): unknown => {
    if (typeof value === "string") {
      return key !== undefined && allow.has(key) ? redactor(value) : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, key));
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
      return out;
    }
    return value;
  };

  return walk(data, undefined) as T;
}
