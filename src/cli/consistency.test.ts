import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { buildProgram, COMMANDS } from "./program.js";

/**
 * buildProgram() only builds the commander tree: no argv parsing, no action
 * run, so calling it here is side-effect free.
 */

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const README = readFileSync(resolve(repoRoot, "README.md"), "utf8");
const SKILL = readFileSync(resolve(repoRoot, "skills", "SKILL.md"), "utf8");

function topLevelNames(program: Command): string[] {
  return program.commands.map((c) => c.name());
}

function readmeCommandsBlock(readme: string): string {
  const startIdx = readme.indexOf("\n## Commands\n");
  if (startIdx === -1) throw new Error('README.md is missing a "## Commands" section');
  const rest = readme.slice(startIdx);
  const nextHeadingIdx = rest.slice(1).search(/\n## /);
  const section = nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx + 1);
  const fenceMatch = section.match(/```([\s\S]*?)```/);
  if (!fenceMatch) throw new Error('README.md "## Commands" section has no fenced code block');
  return fenceMatch[1];
}

function extractReadmeCommandNames(readme: string): Set<string> {
  const block = readmeCommandsBlock(readme);
  const names = new Set<string>();
  for (const rawLine of block.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("oled")) continue;
    const beforeComment = trimmed.split("#")[0].trim();
    const parts = beforeComment.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      names.add("status"); // bare `oled` line == the status default action
      continue;
    }
    names.add(parts[1]);
  }
  return names;
}

function extractOledCodeSpans(md: string): string[] {
  const spans: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m[1].startsWith("oled ") || m[1] === "oled") spans.push(m[1]);
  }
  return spans;
}

function isFlagToken(token: string): boolean {
  return /^[[\]|]*--/.test(token);
}

/** True for a `<placeholder>` operand (also matches `"<why>"`-style quoted operands). */
function isArgToken(token: string): boolean {
  return token.includes("<");
}

/** The command noun a span names; undefined for a bare `oled`, a root flag, or a template placeholder. */
function commandNounOf(span: string): string | undefined {
  const noun = span.trim().split(/\s+/)[1];
  if (!noun || isFlagToken(noun) || isArgToken(noun)) return undefined;
  return noun;
}

function extractSpanNouns(md: string): Set<string> {
  const nouns = new Set<string>();
  for (const span of extractOledCodeSpans(md)) {
    const noun = commandNounOf(span);
    if (noun) nouns.add(noun);
  }
  return nouns;
}

/** The first bare (non-flag, non-placeholder) token after the noun, or undefined. */
function firstSubToken(span: string): string | undefined {
  const tokens = span.trim().split(/\s+/).filter(Boolean);
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (isFlagToken(t) || isArgToken(t)) continue;
    return t.replace(/^[[\]|]+/, "").replace(/[[\]|]+$/, "");
  }
  return undefined;
}

/**
 * Resolves the command a doc code-span like `oled transactions recategorize
 * --set-account <id> ...` refers to, drilling into a subcommand when named.
 */
function resolveTargetCommand(program: Command, span: string): Command | undefined {
  const nounName = commandNounOf(span);
  if (!nounName) return undefined;
  const nounCmd = program.commands.find((c) => c.name() === nounName);
  if (!nounCmd) return undefined;
  if (nounCmd.commands.length === 0) return nounCmd;

  const sub = firstSubToken(span);
  if (!sub) return nounCmd;
  const child = nounCmd.commands.find((c) => c.name() === sub);
  return child ?? nounCmd;
}

/** Every `--flag` token mentioned in a code span (brackets/pipes/values stripped). */
function extractFlagTokens(span: string): string[] {
  const tokens = span.trim().split(/\s+/).filter(Boolean);
  const flags: string[] = [];
  for (const t of tokens) {
    if (!isFlagToken(t)) continue;
    const bare = t.replace(/^[[\]|]+/, "").replace(/[[\]|]+$/, "");
    if (bare.startsWith("--")) flags.push(bare);
  }
  return flags;
}

describe("docs consistency (no subprocesses)", () => {
  // The program-reading tests below all construct the tree, so an import-time
  // or construction side effect fails the file.
  it("top-level command names: program tree == README Commands section == SKILL.md spans == help-screen COMMANDS array", () => {
    const program = buildProgram();
    const fromProgram = new Set(topLevelNames(program));
    const fromReadme = extractReadmeCommandNames(README);
    const fromSkill = extractSpanNouns(SKILL);
    const fromCommandsArray = new Set(COMMANDS.map((c) => c.name));

    expect(fromReadme).toEqual(fromProgram);
    expect(fromSkill).toEqual(fromProgram);
    expect(fromCommandsArray).toEqual(fromProgram);
  });

  it("every subcommand named in a SKILL.md span resolves to a real subcommand (no silent fallback to the parent)", () => {
    const program = buildProgram();
    const problems: string[] = [];

    for (const span of extractOledCodeSpans(SKILL)) {
      const noun = commandNounOf(span);
      if (!noun) continue;
      // Unknown nouns are the noun-set test's job; here we only vet the subcommand.
      const nounCmd = program.commands.find((c) => c.name() === noun);
      if (!nounCmd || nounCmd.commands.length === 0) continue;

      const sub = firstSubToken(span);
      if (!sub) continue; // span targets the parent noun (e.g. `oled config --init`)
      const child = nounCmd.commands.find((c) => c.name() === sub);
      if (!child) problems.push(`\`${span}\`: \`${sub}\` is not a subcommand of \`${noun}\``);
    }
    expect(problems).toEqual([]);
  });

  it("every --flag on an oled span in SKILL.md is a real option on the resolved command", () => {
    const program = buildProgram();
    const globalFlags = new Set(["--json", "--no-color"]);
    const problems: string[] = [];
    const sources: Array<[string, string]> = [["SKILL.md", SKILL]];

    for (const [label, md] of sources) {
      for (const span of extractOledCodeSpans(md)) {
        // Bare `oled`, root flags, and generic `--help` templates name no command to check.
        if (!commandNounOf(span)) continue;
        const target = resolveTargetCommand(program, span);
        if (!target) {
          problems.push(`${label}: unresolvable command for \`${span}\``);
          continue;
        }
        const realFlags = new Set(target.options.map((o) => o.long).filter((f): f is string => !!f));
        for (const flag of extractFlagTokens(span)) {
          if (globalFlags.has(flag)) continue;
          if (!realFlags.has(flag)) {
            problems.push(`${label}: \`${span}\`: ${flag} is not an option on \`${target.name()}\``);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("SKILL.md stays under the size budget", () => {
    expect(SKILL.length).toBeLessThan(20_000);
  });

  // The frontmatter's own shape is pinned harder in src/setup/install.test.ts,
  // which parses it and checks the exact name and a minimum description length.
  it("SKILL.md carries no references/ pointer", () => {
    expect(SKILL.includes("references/")).toBe(false);
  });
});
