import * as z from "zod";
import type { Result } from "./result.js";

/** Thrown by `parseInput` on a failed parse. `src/lib/` has no dependency on
 *  `src/cli/`, so the CLI layer maps this to its own error/exit-code type. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// Each preprocess below passes undefined through, so an absent required key
// surfaces as a missing-required issue rather than a coerced value.
const toStringInput = (value: unknown): unknown =>
  typeof value === "string" || value === undefined ? value : String(value);

/** Non-finite results pass the raw value through so z.number rejects it and the
 *  formatter echoes the original in `got "<value>"`; "" and null coerce to 0 via Number(). */
const toNumberInput = (value: unknown): unknown => {
  if (typeof value === "number") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
};

const toBooleanInput = (value: unknown): unknown => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
};

export function str() {
  return z.preprocess(toStringInput, z.string());
}

export function num() {
  return z.preprocess(toNumberInput, z.number());
}

export function int() {
  return z.preprocess(toNumberInput, z.number().int());
}

export function bool() {
  return z.preprocess(toBooleanInput, z.boolean());
}

/** A parse failure raises a custom issue carrying the JSON.parse message. */
export function json<T = unknown>() {
  return z.unknown().transform((value, ctx): T => {
    if (typeof value !== "string") return value as T;
    try {
      return JSON.parse(value) as T;
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
      return z.NEVER;
    }
  });
}

interface ParseOptions {
  /** Extra raw-input keys to read per spec key (genuine synonyms). */
  aliases?: Record<string, string[]>;
  /** Override the default `--key-with-dashes` label per spec key. */
  labels?: Record<string, string>;
  /** Fail with this message when the parse produces zero output keys. */
  atLeastOne?: string;
}

function defaultLabel(key: string): string {
  return "--" + key.replace(/_/g, "-");
}

function toCamelCase(key: string): string {
  return key.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}

/** Auto-bridges commander's camelCase opts to the snake_case names specs are
 *  written in; first non-`undefined` candidate wins. */
function resolveRaw(
  raw: Record<string, unknown>,
  key: string,
  aliases: readonly string[],
): unknown {
  const candidates = [key, toCamelCase(key), toSnakeCase(key), ...aliases];
  for (const candidate of candidates) {
    const value = raw[candidate];
    if (value !== undefined) return value;
  }
  return undefined;
}

// Absent keys are omitted so zod's optional/default/required handling stays authoritative.
function normalizeRaw(
  shape: Record<string, unknown>,
  raw: Record<string, unknown>,
  aliases: Record<string, string[]> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    const value = resolveRaw(raw, key, aliases[key] ?? []);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

interface Issue {
  code: string;
  message: string;
  path: PropertyKey[];
  expected?: string;
  values?: unknown[];
}

/** Render one non-missing issue into the pinned `<label> <constraint>` clause,
 *  echoing the raw pre-coercion value in `got "<value>"`. */
function constraintClause(label: string, issue: Issue, raw: unknown): string {
  if (issue.code === "custom") return `${label} must be valid JSON: ${issue.message}`;
  if (issue.code === "invalid_value") {
    return `${label} must be one of ${(issue.values ?? []).join(", ")}, got "${String(raw)}"`;
  }
  if (issue.expected === "int") return `${label} must be an integer, got "${String(raw)}"`;
  if (issue.expected === "number") return `${label} must be a number, got "${String(raw)}"`;
  if (issue.expected === "boolean") return `${label} must be a boolean, got "${String(raw)}"`;
  return `${label} ${issue.message}`;
}

/** An issue whose normalized value is `undefined` is a missing-required field.
 *  All-missing groups as `--a, --b required`; otherwise clauses join with "; ". */
function formatError(
  shape: Record<string, unknown>,
  normalized: Record<string, unknown>,
  issues: Issue[],
  opts?: ParseOptions,
): string {
  const first = new Map<string, Issue>();
  for (const issue of issues) {
    const key = String(issue.path[0]);
    if (!first.has(key)) first.set(key, issue);
  }

  const missing: string[] = [];
  const clauses: string[] = [];
  let hasConstraint = false;
  for (const key of Object.keys(shape)) {
    const issue = first.get(key);
    if (!issue) continue;
    const label = opts?.labels?.[key] ?? defaultLabel(key);
    if (normalized[key] === undefined) {
      missing.push(label);
      clauses.push(`${label} required`);
    } else {
      hasConstraint = true;
      clauses.push(constraintClause(label, issue, normalized[key]));
    }
  }

  if (!hasConstraint) return `${missing.join(", ")} required`;
  return clauses.join("; ");
}

function parse<S extends z.ZodObject>(
  schema: S,
  raw: Record<string, unknown>,
  opts?: ParseOptions,
): Result<z.infer<S>> {
  const shape = schema.shape as Record<string, unknown>;
  const normalized = normalizeRaw(shape, raw, opts?.aliases);
  const parsed = schema.safeParse(normalized);
  if (parsed.success) return { ok: true, value: parsed.data as z.infer<S> };
  return {
    ok: false,
    error: formatError(shape, normalized, parsed.error.issues as unknown as Issue[], opts),
  };
}

/** Accumulates every missing-required and coercion error into one thrown `ValidationError`. */
export function parseInput<S extends z.ZodObject>(
  schema: S,
  raw: Record<string, unknown>,
  opts?: ParseOptions,
): z.infer<S> {
  const result = parse(schema, raw, opts);
  if (!result.ok) throw new ValidationError(result.error);
  if (opts?.atLeastOne && Object.keys(result.value as object).length === 0) {
    throw new ValidationError(opts.atLeastOne);
  }
  return result.value;
}

/** For batch rows, which must keep the PARTIAL exit-code contract instead of throwing. */
export function safeParse<S extends z.ZodObject>(
  schema: S,
  raw: Record<string, unknown>,
  opts?: ParseOptions,
): Result<z.infer<S>> {
  return parse(schema, raw, opts);
}
