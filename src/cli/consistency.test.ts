import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { buildProgram } from "./program.js";

// buildProgram() only builds the commander tree: no argv parsing, no action run.
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const README = readFileSync(resolve(repoRoot, "README.md"), "utf8");
const SKILL = readFileSync(resolve(repoRoot, "skills", "openledger", "SKILL.md"), "utf8");

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

function firstSubToken(span: string): string | undefined {
  const tokens = span.trim().split(/\s+/).filter(Boolean);
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (isFlagToken(t) || isArgToken(t)) continue;
    return t.replace(/^[[\]|]+/, "").replace(/[[\]|]+$/, "");
  }
  return undefined;
}

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
  it("top-level command names: program tree == README Commands section == SKILL.md spans", () => {
    const program = buildProgram();
    const fromProgram = new Set(topLevelNames(program));
    const fromReadme = extractReadmeCommandNames(README);
    const fromSkill = extractSpanNouns(SKILL);

    expect(fromReadme).toEqual(fromProgram);
    expect(fromSkill).toEqual(fromProgram);
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
    // --help is commander's own, present on every command but absent from `options`.
    const globalFlags = new Set(["--json", "--no-color", "--config", "--help"]);
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
          // --config is global everywhere EXCEPT the config command, which is positional-only.
          if (globalFlags.has(flag) && !(target.name() === "config" && flag === "--config")) continue;
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

  // The frontmatter's own shape is pinned harder in src/setup/install.test.ts.
  it("SKILL.md carries no references/ pointer", () => {
    expect(SKILL.includes("references/")).toBe(false);
  });
});

const PLUGIN_MANIFEST = JSON.parse(readFileSync(resolve(repoRoot, "plugin.json"), "utf8")) as Record<string, unknown>;
const PACKAGE = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as Record<string, unknown>;

// Permitted top-level fields of the closed manifest schema (spec §5.2).
const PERMITTED_MANIFEST_FIELDS = [
  "$schema", "name", "version", "description", "author",
  "homepage", "repository", "license", "keywords", "extensions",
];

describe("plugin manifest (agent-plugins.org 1.0)", () => {
  it("declares the exact 1.0.0 schema id", () => {
    expect(PLUGIN_MANIFEST.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  });

  it("name obeys the spec pattern and names an existing skill directory", () => {
    const name = PLUGIN_MANIFEST.name as string;
    expect(name).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(existsSync(resolve(repoRoot, "skills", name, "SKILL.md"))).toBe(true);
    // agentskills.io hard rule: the skill's frontmatter name equals its directory name.
    expect(SKILL).toMatch(new RegExp(`^name: ${name}$`, "m"));
  });

  it("uses only fields the closed schema permits", () => {
    const unknown = Object.keys(PLUGIN_MANIFEST).filter((key) => !PERMITTED_MANIFEST_FIELDS.includes(key));
    expect(unknown).toEqual([]);
    // The author sub-schema is closed too, so it needs its own check.
    const author = (PLUGIN_MANIFEST.author ?? {}) as Record<string, unknown>;
    expect(Object.keys(author).filter((key) => !["name", "email", "url"].includes(key))).toEqual([]);
  });

  it("mirrors package.json version, description, and license", () => {
    expect(PLUGIN_MANIFEST.version).toBe(PACKAGE.version);
    expect(PLUGIN_MANIFEST.description).toBe(PACKAGE.description);
    expect(PLUGIN_MANIFEST.license).toBe(PACKAGE.license);
  });
});
