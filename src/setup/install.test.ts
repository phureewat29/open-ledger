import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, getVersion, skillMd, SkillPackVersionError } from "./install.js";
import { DEFAULT_SKILLS_DIR } from "./locations.js";
import {
  createSandbox,
  makeRunCLI,
  type CLIRunner,
  type Sandbox,
} from "../../fixtures/sandbox.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// No yaml dep: key: value pairs between the fences.
function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  expect(m, "SKILL.md should start with a --- frontmatter block").toBeTruthy();
  const out: Record<string, string> = {};
  for (const line of m![1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

describe("skillMd (checked-in skills/SKILL.md)", () => {
  it("carries name/description frontmatter and no version key", () => {
    const fm = parseFrontmatter(skillMd());
    expect(fm.name).toBe("openledger");
    expect(fm.description.length).toBeGreaterThan(20);
    expect(fm.version).toBeUndefined();
  });

  it("defers usage guidance to the CLI's own help", () => {
    const skill = skillMd();
    expect(skill).toContain("oled <noun> --help");
    expect(skill).toContain("--json");
  });

  it("keeps banned vocabulary out", () => {
    expect(skillMd()).not.toContain("record ");
  });

  it("carries the two facts a model cannot infer from output alone", () => {
    const skill = skillMd();
    expect(skill).toContain("has_more");
    expect(skill).toContain("never add two currencies");
  });

  it("carries the Setup bootstrap section (install + first-run for a bare environment)", () => {
    const skill = skillMd();
    expect(skill).toContain("## Setup");
    expect(skill).toContain("node --version");
    expect(skill).toContain("npm install -g @aquartier/openledger");
  });
});

// macOS tmpdir is a symlink (/var -> /private/var); realpath matches what process.cwd() canonicalizes.
describe("installSkill: target resolution", () => {
  it("--dir D is the skills dir itself: the pack lands at D/openledger, nothing appended", () => {
    const dir = tmp("oled-install-dir-");
    try {
      const target = installSkill({ dir });
      const skillDir = join(dir, "openledger");
      expect(target).toMatchObject({ path: skillDir, version: getVersion() });
      expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
      expect(readFileSync(join(skillDir, "VERSION"), "utf8").trim()).toBe(getVersion());
      const fm = parseFrontmatter(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
      expect(fm.name).toBe("openledger");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dir <host skills dir> does not append a second skills segment", () => {
    const base = tmp("oled-install-host-dir-");
    const dir = join(base, ".claude", "skills");
    try {
      const target = installSkill({ dir });
      expect(target.path).toBe(join(base, ".claude", "skills", "openledger"));
      expect(existsSync(join(target.path, "SKILL.md"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it(`defaults to ${DEFAULT_SKILLS_DIR} under the cwd when no --dir is given`, () => {
    const cwd = tmp("oled-install-default-");
    const prevCwd = process.cwd();
    try {
      process.chdir(cwd);
      const target = installSkill({});
      expect(realpathSync(target.path)).toBe(
        realpathSync(join(cwd, ...DEFAULT_SKILLS_DIR.split("/"), "openledger")),
      );
      expect(existsSync(join(target.path, "SKILL.md"))).toBe(true);
      expect(target.version).toBe(getVersion());
    } finally {
      process.chdir(prevCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

});

describe("installSkill: version guard", () => {
  it("is idempotent when re-installed at the same version", () => {
    const dir = tmp("oled-install-idem-");
    try {
      installSkill({ dir });
      expect(() => installSkill({ dir })).not.toThrow();
      expect(readFileSync(join(dir, "openledger", "VERSION"), "utf8").trim()).toBe(getVersion());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws SkillPackVersionError on a version clash without --force, succeeds with it", () => {
    const dir = tmp("oled-install-clash-");
    try {
      installSkill({ dir });
      const versionPath = join(dir, "openledger", "VERSION");
      writeFileSync(versionPath, "0.0.1\n");

      let err: unknown;
      try {
        installSkill({ dir });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SkillPackVersionError);
      expect((err as SkillPackVersionError).installedVersion).toBe("0.0.1");
      expect((err as SkillPackVersionError).cliVersion).toBe(getVersion());

      expect(() => installSkill({ dir, force: true })).not.toThrow();
      expect(readFileSync(versionPath, "utf8").trim()).toBe(getVersion());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

let sandbox: Sandbox;
let runCLI: CLIRunner;

beforeAll(() => {
  sandbox = createSandbox("oled-setup-cli-it-");
  runCLI = makeRunCLI(sandbox);
});

afterAll(() => {
  sandbox.cleanup();
});

describe("setup CLI (subprocess)", () => {
  it(
    "--print emits raw SKILL.md with parseable frontmatter",
    async () => {
      const res = await runCLI(["setup", "--print"]);
      expect(res.code).toBe(0);
      expect(res.stdout.startsWith("---\n")).toBe(true);
      const fm = parseFrontmatter(res.stdout);
      expect(fm.name).toBe("openledger");
    },
    30000,
  );

  it(
    "--dir installs the pack and reports its path as JSON",
    async () => {
      const dir = tmp("oled-cli-install-");
      try {
        const res = await runCLI(["setup", "--dir", dir, "--json"]);
        expect(res.code).toBe(0);
        const parsed = JSON.parse(res.stdout.trim());
        expect(parsed.installed[0]).toMatchObject({ path: join(dir, "openledger") });
        expect(existsSync(join(dir, "openledger", "SKILL.md"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30000,
  );

  it(
    "--global and --dir together is a usage error",
    async () => {
      const dir = tmp("oled-cli-install-conflict-");
      try {
        const res = await runCLI(["setup", "--global", "--dir", dir, "--json"]);
        expect(res.code).toBe(2); // EXIT.USAGE
        expect(JSON.parse(res.stderr.trim()).error.code).toBe("E_USAGE");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30000,
  );

  it(
    "--global installs under the shared home skills dir",
    async () => {
      const res = await runCLI(["setup", "--global", "--json"]);
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout.trim());
      const expected = join(sandbox.home, ".agents", "skills", "openledger");
      expect(parsed.installed[0]).toMatchObject({ path: expected });
      expect(existsSync(join(expected, "SKILL.md"))).toBe(true);
    },
    30000,
  );
});
