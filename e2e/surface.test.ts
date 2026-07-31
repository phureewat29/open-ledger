import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSandbox, makeRunCLI, type CLIRunner, type Sandbox } from "../fixtures/sandbox.js";

let sandbox: Sandbox;
let runCLI: CLIRunner;

// One sandbox for every case below: they only read, against a ledger seeded by one `config --init`.
beforeAll(async () => {
  sandbox = createSandbox("oled-e2e-read-");
  runCLI = makeRunCLI(sandbox, "dist");
  const init = await runCLI(["config", "--init", "--json"]);
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
  /** A list read: its last stdout line must be the summary row. */
  list?: boolean;
}

// The whole surface an agent can reach before anything is ingested; per-command payloads are
// pinned under src/, this table pins only the uniform wire contract across all of them.
const SURFACE_CASES: SurfaceCase[] = [
  { label: "status", args: ["status"], exit: 0 },
  { label: "doctor", args: ["doctor"], exit: 0 },
  { label: "config show", args: ["config", "show"], exit: 0 },
  { label: "ingest list", args: ["ingest", "list"], exit: 0, list: true },
  { label: "files list", args: ["files", "list"], exit: 0, list: true },
  { label: "transactions list", args: ["transactions", "list"], exit: 0, list: true },
  { label: "transactions list --group", args: ["transactions", "list", "--group"], exit: 0, list: true },
  { label: "transactions dedupe", args: ["transactions", "dedupe"], exit: 0, list: true },
  { label: "accounts list", args: ["accounts", "list"], exit: 0, list: true },
  { label: "accounts tree", args: ["accounts", "tree"], exit: 0, list: true },
  { label: "merchants list", args: ["merchants", "list"], exit: 0, list: true },
  { label: "questions list", args: ["questions", "list"], exit: 0, list: true },
  { label: "report", args: ["report", "--from", "2026-01-01", "--to", "2026-01-31"], exit: 0 },
  { label: "notes list", args: ["notes", "list"], exit: 0, list: true },
  { label: "datasets", args: ["datasets"], exit: 0, list: true },
  {
    label: "datasets institutions --country th",
    args: ["datasets", "institutions", "--country", "th"],
    exit: 0,
    list: true,
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

// Blank lines carry nothing; every other line must parse to one JSON object. A top-level
// array or scalar is a contract breach even though it would JSON.parse.
function nonObjectLines(stream: string): string[] {
  return stream.split("\n").filter((line) => {
    if (line.trim().length === 0) return false;
    try {
      const value = JSON.parse(line);
      return value === null || typeof value !== "object" || Array.isArray(value);
    } catch {
      return true;
    }
  });
}

function lastLine(stream: string): string {
  const lines = stream.split("\n").filter((line) => line.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

describe("money aggregates on a virgin ledger (dist subprocess)", () => {
  // Every aggregate is a map keyed by ISO currency code, never a scalar to add across
  // currencies; a virgin ledger has no postings at all, which is what an empty map means.
  it("status and report carry currency-keyed maps, empty before anything is posted", async () => {
    const status = await runCLI(["status", "--json"]);
    expect(status.code, `stderr: ${status.stderr}`).toBe(0);
    expect(JSON.parse(status.stdout.trim()).net_worth).toEqual({
      assets: {},
      liabilities: {},
      net_worth: {},
    });

    const args = ["report", "--from", "2026-01-01", "--to", "2026-01-31", "--json"];
    const report = await runCLI(args);
    expect(report.code, `stderr: ${report.stderr}`).toBe(0);
    expect(JSON.parse(report.stdout.trim())).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
      income: {},
      expenses: {},
      net: {},
    });
  }, 20000);

  it("every accounts tree node carries its currency and a keyed rollup", async () => {
    const tree = await runCLI(["accounts", "tree", "--json"]);
    expect(tree.code, `stderr: ${tree.stderr}`).toBe(0);

    const nodes = tree.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
      .filter((node) => node.type !== "summary");

    // config --init seeds the display-currency ledger's structural accounts: exactly the
    // expense and equity type roots.
    expect(nodes.map((n) => n.id).sort()).toEqual(["thb:equity", "thb:expense"]);
    expect(nodes.find((n) => n.id === "thb:expense")).toEqual({
      id: "thb:expense",
      name: "Expenses (THB)",
      type: "expense",
      currency: "THB",
      balance: 0,
      rollup: { THB: 0 },
      children: [
        {
          id: "thb:expense:uncategorized",
          name: "Uncategorized (THB)",
          type: "expense",
          currency: "THB",
          balance: 0,
          rollup: { THB: 0 },
          children: [],
        },
      ],
    });
  }, 20000);
});

describe("CLI surface on a virgin ledger (dist subprocess)", () => {
  it.each(SURFACE_CASES)(
    "oled $label exits $exit with NDJSON-only, ANSI-free output on both streams",
    async ({ args, exit, list }) => {
      const { stdout, stderr, code } = await runCLI([...args, "--json"]);

      expect(code, `stderr: ${stderr}`).toBe(exit);
      expect(nonObjectLines(stdout), "stdout lines that are not one JSON object").toEqual([]);
      expect(nonObjectLines(stderr), "stderr lines that are not one JSON object").toEqual([]);
      expect(stdout, "ANSI escape bytes on stdout").not.toMatch(ESC);
      expect(stderr, "ANSI escape bytes on stderr").not.toMatch(ESC);

      // A list read always ends with its summary, so an empty result is one
      // summary line, never zero bytes.
      if (list) {
        expect(JSON.parse(lastLine(stdout)).type, "last stdout line").toBe("summary");
      }
    },
    20000,
  );
});
