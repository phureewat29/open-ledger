import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSandbox, makeRunCli, type CliRunner, type Sandbox } from "../fixtures/sandbox.js";

let sandbox: Sandbox;
let runCli: CliRunner;

/**
 * One sandbox for every case below: they only read, against a ledger seeded by
 * one explicit `config --init`: doctor and status create nothing on their own.
 */
beforeAll(async () => {
  sandbox = createSandbox("oled-e2e-read-");
  runCli = makeRunCli(sandbox, "dist");
  const init = await runCli(["config", "--init", "--json"]);
  if (init.code !== 0) throw new Error(`config --init failed: ${init.stderr}`);
}, 30000);

afterAll(() => {
  sandbox.cleanup();
});

const ESC = /\x1b/;

interface SurfaceCase {
  label: string;
  args: string[];
  exit: number;
}

/**
 * The whole surface an agent can reach before anything is ingested. The
 * per-command payloads are pinned by the suites under `src/`; what this table
 * pins is the uniform wire contract across all of them at once.
 */
const SURFACE_CASES: SurfaceCase[] = [
  { label: "status", args: ["status"], exit: 0 },
  { label: "doctor", args: ["doctor"], exit: 0 },
  { label: "config show", args: ["config", "show"], exit: 0 },
  { label: "ingest list", args: ["ingest", "list"], exit: 0 },
  { label: "files list", args: ["files", "list"], exit: 0 },
  { label: "transactions list", args: ["transactions", "list"], exit: 0 },
  { label: "transactions list --group", args: ["transactions", "list", "--group"], exit: 0 },
  { label: "transactions dedupe", args: ["transactions", "dedupe"], exit: 0 },
  { label: "accounts list", args: ["accounts", "list"], exit: 0 },
  { label: "accounts tree", args: ["accounts", "tree"], exit: 0 },
  { label: "merchants list", args: ["merchants", "list"], exit: 0 },
  { label: "questions list", args: ["questions", "list"], exit: 0 },
  { label: "report", args: ["report", "--from", "2026-01-01", "--to", "2026-01-31"], exit: 0 },
  { label: "notes list", args: ["notes", "list"], exit: 0 },
  { label: "datasets", args: ["datasets"], exit: 0 },
  {
    label: "datasets institutions --country th",
    args: ["datasets", "institutions", "--country", "th"],
    exit: 0,
  },
  {
    label: "transactions show tx:nonexistent",
    args: ["transactions", "show", "tx:nonexistent"],
    exit: 5, // EXIT.NOT_FOUND
  },
  {
    label: "transactions delete tx:nonexistent",
    args: ["transactions", "delete", "tx:nonexistent", "--yes"],
    exit: 5, // EXIT.NOT_FOUND
  },
];

/** Blank lines carry no contract; every other line on either stream must be one JSON value. */
function nonJsonLines(stream: string): string[] {
  return stream.split("\n").filter((line) => {
    if (line.trim().length === 0) return false;
    try {
      JSON.parse(line);
      return false;
    } catch {
      return true;
    }
  });
}

describe("CLI surface on a virgin ledger (dist subprocess)", () => {
  it.each(SURFACE_CASES)(
    "oled $label exits $exit with NDJSON-only, ANSI-free output on both streams",
    async ({ args, exit }) => {
      const { stdout, stderr, code } = await runCli([...args, "--json"]);

      expect(code, `stderr: ${stderr}`).toBe(exit);
      expect(nonJsonLines(stdout), "stdout lines that are not JSON").toEqual([]);
      expect(nonJsonLines(stderr), "stderr lines that are not JSON").toEqual([]);
      expect(stdout, "ANSI escape bytes on stdout").not.toMatch(ESC);
      expect(stderr, "ANSI escape bytes on stderr").not.toMatch(ESC);
    },
    20000,
  );
});
