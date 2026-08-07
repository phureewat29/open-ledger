import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { ValidationError } from "../lib/validate.js";
import { DBNotReadyError } from "../db/errors.js";
import type { AccountFailure } from "../accounts/accounts.js";
import {
  EXIT,
  REASON_EXIT,
  fail,
  failReason,
  mapNotFoundError,
  runAction,
  toCLIError,
} from "./output.js";

// Reset so a failing-exit-code assertion in one test can't leak into vitest's own exit code.
afterEach(() => {
  process.exitCode = undefined;
});

interface ThrownCLIError {
  code: keyof typeof EXIT;
  message: string;
  hint?: string;
  details?: unknown;
}

// CLIError is unexported; fail()/failReason() are its only construction sites.
function thrownBy(raise: () => never): ThrownCLIError {
  try {
    raise();
  } catch (err) {
    return err as ThrownCLIError;
  }
  throw new Error("unreachable: raise() always throws");
}

function makeCLIError(...args: Parameters<typeof fail>): ThrownCLIError {
  return thrownBy(() => fail(...args));
}

function jsonCommand(): Command {
  const program = new Command();
  program.option("--json");
  program.parse(["--json"], { from: "user" });
  return program;
}

// --json on an ancestor, action receiving the leaf: pins the parent-chain walk in resolveMode.
function nestedJsonLeaf(): Command {
  const program = new Command();
  program.option("--json");
  const leaf = program.command("list");
  program.parse(["--json", "list"], { from: "user" });
  return leaf;
}

async function captureReport(
  err: unknown,
  cmd?: Command,
): Promise<{ exitCode: typeof process.exitCode; stderrLines: string[] }> {
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const action = runAction((_cmd?: Command): never => {
      throw err;
    });
    await action(cmd);
    const stderrLines = writeSpy.mock.calls.map((call) => String(call[0]));
    return { exitCode: process.exitCode, stderrLines };
  } finally {
    writeSpy.mockRestore();
  }
}

describe("toCLIError: classification", () => {
  it("passes a CLIError through unchanged", () => {
    const original = makeCLIError("NOT_FOUND", "widget:1 not found", { hint: "check the id" });
    expect(toCLIError(original)).toBe(original);
  });

  it("maps a ValidationError to USAGE (exit 2) with its message", () => {
    const result = toCLIError(new ValidationError("--id required"));
    expect(result.code).toBe("USAGE");
    expect(EXIT[result.code]).toBe(2);
    expect(result.message).toBe("--id required");
    expect(result.hint).toBe("append --help to the command for its flags and usage");
  });

  it("maps an unknown Error to GENERIC (exit 1)", () => {
    const result = toCLIError(new Error("boom"));
    expect(result.code).toBe("GENERIC");
    expect(EXIT[result.code]).toBe(1);
    expect(result.message).toBe("boom");
    expect(result.hint).toBeUndefined();
  });

  const NON_ERROR_CASES: [unknown, string][] = [
    [42, "42"],
    ["plain string", "plain string"],
    [{ weird: true }, "[object Object]"],
    [null, "null"],
    [undefined, "undefined"],
  ];

  it.each(NON_ERROR_CASES)(
    "maps a non-Error thrown value %p to GENERIC with String(value) => %s",
    (thrown, expected) => {
      const result = toCLIError(thrown);
      expect(result.code).toBe("GENERIC");
      expect(EXIT[result.code]).toBe(1);
      expect(result.message).toBe(expected);
    },
  );

  it("maps a DBNotReadyError to NOT_READY (exit 3) with the init hint", () => {
    const message = "This database is not an OpenLedger database.";
    const result = toCLIError(new DBNotReadyError(message));
    expect(result.code).toBe("NOT_READY");
    expect(EXIT[result.code]).toBe(3);
    expect(result.message).toBe(message);
    expect(result.hint).toBe("run `oled config --init` to configure the harness");
  });

  // Matching by wording would let a reword silently move an exit code; the type is the only signal.
  const FORMER_NOT_READY_WORDINGS = [
    "failed to open database",
    "corrupt database",
    "not a database",
    "file is encrypted",
    "not configured",
    "not an openledger database",
  ];

  it.each(FORMER_NOT_READY_WORDINGS)(
    "leaves a plain Error saying %j as GENERIC (exit 1)",
    (wording) => {
      const result = toCLIError(new Error(`sqlite: ${wording}`));
      expect(result.code).toBe("GENERIC");
      expect(EXIT[result.code]).toBe(1);
    },
  );
});

interface ReasonCase {
  reason: AccountFailure;
  code: keyof typeof EXIT;
  exitCode: number;
}

/** Pinned as data, not read off REASON_EXIT: a re-pointed reason must fail here. */
const REASON_CASES: ReasonCase[] = [
  { reason: "account_exists", code: "INVALID", exitCode: 6 },
  { reason: "parent_not_found", code: "NOT_FOUND", exitCode: 5 },
  { reason: "invalid_hierarchy", code: "INVALID", exitCode: 6 },
];

describe("failReason", () => {
  it.each(REASON_CASES)("$reason exits $code ($exitCode)", ({ reason, code, exitCode }) => {
    const thrown = thrownBy(() => failReason({ reason, message: "refused" }));
    expect(thrown.code).toBe(code);
    expect(EXIT[thrown.code]).toBe(exitCode);
    expect(thrown.message).toBe("refused");
    expect(thrown.hint).toBeUndefined();
  });

  it("carries a hint only when one is given", () => {
    const thrown = thrownBy(() =>
      failReason({ reason: "parent_not_found", message: "no parent" }, "create it first"),
    );
    expect(thrown.hint).toBe("create it first");
  });

  it("assigns an exit code to every reason arm", () => {
    expect(Object.keys(REASON_EXIT).sort()).toEqual(REASON_CASES.map((c) => c.reason).sort());
  });
});

describe("reportError: rendering (via runAction)", () => {
  it("json mode emits one NDJSON line to stderr with hint and details when present", async () => {
    const err = makeCLIError("NOT_FOUND", "widget:1 not found", {
      hint: "check the id",
      details: { id: "widget:1" },
    });
    const { exitCode, stderrLines } = await captureReport(err, jsonCommand());
    expect(exitCode).toBe(EXIT.NOT_FOUND);
    expect(stderrLines).toHaveLength(1);
    expect(JSON.parse(stderrLines[0])).toEqual({
      error: {
        code: "E_NOT_FOUND",
        message: "widget:1 not found",
        hint: "check the id",
        details: { id: "widget:1" },
      },
    });
  });

  it("json mode omits hint and details keys entirely when absent", async () => {
    const { exitCode, stderrLines } = await captureReport(new Error("boom"), jsonCommand());
    expect(exitCode).toBe(EXIT.GENERIC);
    // An exact toEqual is already the key-set check the title asks for.
    expect(JSON.parse(stderrLines[0]).error).toEqual({ code: "E_GENERIC", message: "boom" });
  });

  it("json mode is honored when --json sits on an ancestor command", async () => {
    const { exitCode, stderrLines } = await captureReport(new Error("boom"), nestedJsonLeaf());
    expect(exitCode).toBe(EXIT.GENERIC);
    expect(stderrLines).toHaveLength(1);
    expect(JSON.parse(stderrLines[0])).toEqual({
      error: { code: "E_GENERIC", message: "boom" },
    });
  });

  it("plain mode writes error: and hint: lines", async () => {
    const err = makeCLIError("USAGE", "bad flag", { hint: "see --help" });
    const { exitCode, stderrLines } = await captureReport(err);
    expect(exitCode).toBe(EXIT.USAGE);
    expect(stderrLines).toEqual(["error: bad flag\n", "hint: see --help\n"]);
  });

  it("plain mode omits the hint line when absent", async () => {
    const { exitCode, stderrLines } = await captureReport(new Error("boom"));
    expect(exitCode).toBe(EXIT.GENERIC);
    expect(stderrLines).toEqual(["error: boom\n"]);
  });
});

interface NotFoundCase {
  desc: string;
  message: string;
  code: "NOT_FOUND" | "INVALID";
  exitCode: number;
}

const NOT_FOUND_CASES: NotFoundCase[] = [
  {
    desc: "a message matching /not found/i",
    message: "account:1 not found",
    code: "NOT_FOUND",
    exitCode: 5,
  },
  {
    desc: "a message matching /does not exist/i",
    message: "merchant does not exist",
    code: "NOT_FOUND",
    exitCode: 5,
  },
  {
    desc: "anything else",
    message: "currency mismatch",
    code: "INVALID",
    exitCode: 6,
  },
];

describe("mapNotFoundError", () => {
  it.each(NOT_FOUND_CASES)("throws $code for $desc", ({ message, code, exitCode }) => {
    const err = new Error(message);
    let thrown: unknown;
    try {
      mapNotFoundError(err);
    } catch (caught) {
      thrown = caught;
    }
    // toCLIError's identity passthrough doubles as the CLIError instance check.
    expect(thrown).toBeDefined();
    expect(toCLIError(thrown)).toBe(thrown);
    const cliErr = thrown as ThrownCLIError;
    expect(cliErr.code).toBe(code);
    expect(EXIT[cliErr.code]).toBe(exitCode);
    expect(cliErr.message).toBe(message);
  });
});

const EXIT_TABLE: [keyof typeof EXIT, number][] = [
  ["OK", 0],
  ["GENERIC", 1],
  ["USAGE", 2],
  ["NOT_READY", 3],
  ["INPUT_REQUIRED", 4],
  ["NOT_FOUND", 5],
  ["INVALID", 6],
  ["PARTIAL", 7],
];

describe("EXIT table", () => {
  it.each(EXIT_TABLE)("%s maps to exit code %i", (name, code) => {
    expect(EXIT[name]).toBe(code);
  });

  it("contains exactly the eight documented codes", () => {
    expect(Object.keys(EXIT)).toEqual(EXIT_TABLE.map(([name]) => name));
  });
});
