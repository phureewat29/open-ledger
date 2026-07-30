import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, getVersion, skillMd, SkillPackVersionError } from "./install.js";
import { SKILL_HOSTS } from "./hosts.js";
import {
  createSandbox,
  makeRunCli,
  type CliRunner,
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

  it("carries the no-shell operating mode (human as terminal)", () => {
    const skill = skillMd();
    expect(skill).toContain("one command per message");
  });

  it("keeps banned vocabulary out", () => {
    expect(skillMd()).not.toContain("record ");
  });

  it("carries the Setup bootstrap section (install + first-run for a bare environment)", () => {
    const skill = skillMd();
    expect(skill).toContain("## Setup");
    expect(skill).toContain("node --version");
    expect(skill).toContain("npm install -g @aquartier/openledger");
  });
});

// realpath needed: macOS tmpdir is a symlink (/var -> /private/var), which
// process.cwd() canonicalizes but the raw tmp string does not.
const HOST_PROJECT_DIRS: { host: string; rel: string[] }[] = [
  { host: "agents", rel: [".agents", "skills", "openledger"] },
  { host: "claude", rel: [".claude", "skills", "openledger"] },
  { host: "kimi", rel: [".skills", "openledger"] },
];

describe("SKILL_HOSTS registry", () => {
  it("resolves each host's global skills dir to its documented location (asymmetric globals included)", () => {
    const home = homedir();
    const byId = Object.fromEntries(SKILL_HOSTS.map((h) => [h.id, h]));
    expect(Object.keys(byId).sort()).toEqual(["agents", "claude", "kimi"]);
    expect(byId.agents.globalDir()).toBe(join(home, ".agents", "skills"));
    expect(byId.claude.globalDir()).toBe(join(home, ".claude", "skills"));
    expect(byId.kimi.globalDir()).toBe(join(home, ".agents", "skills"));
  });
});

describe("installSkill — host project dirs (cwd)", () => {
  for (const { host, rel } of HOST_PROJECT_DIRS) {
    it(`${host} installs under ${rel.join("/")}`, () => {
      const cwd = tmp(`oled-install-${host}-`);
      const prevCwd = process.cwd();
      try {
        process.chdir(cwd);
        const target = installSkill({ host });

        expect(target.kind).toBe(host);
        expect(target.version).toBe(getVersion());
        expect(realpathSync(target.path)).toBe(realpathSync(join(cwd, ...rel)));

        expect(existsSync(join(target.path, "SKILL.md"))).toBe(true);
        expect(readFileSync(join(target.path, "VERSION"), "utf8").trim()).toBe(getVersion());
        const fm = parseFrontmatter(readFileSync(join(target.path, "SKILL.md"), "utf8"));
        expect(fm.name).toBe("openledger");
      } finally {
        process.chdir(prevCwd);
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  it("defaults to the shared .agents/skills host when none is given", () => {
    const cwd = tmp("oled-install-default-");
    const prevCwd = process.cwd();
    try {
      process.chdir(cwd);
      const target = installSkill({});
      expect(target.kind).toBe("agents");
      expect(realpathSync(target.path)).toBe(
        realpathSync(join(cwd, ".agents", "skills", "openledger")),
      );
      expect(existsSync(join(target.path, "SKILL.md"))).toBe(true);
    } finally {
      process.chdir(prevCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("installSkill — --dir base and version guard", () => {
  it("--dir D lands the pack at D/skills/openledger with kind 'dir'", () => {
    const dir = tmp("oled-install-dir-");
    try {
      const target = installSkill({ dir });
      const skillDir = join(dir, "skills", "openledger");
      expect(target).toMatchObject({ kind: "dir", path: skillDir, version: getVersion() });
      expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
      expect(readFileSync(join(skillDir, "VERSION"), "utf8").trim()).toBe(getVersion());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent when re-installed at the same version", () => {
    const dir = tmp("oled-install-idem-");
    try {
      installSkill({ dir });
      expect(() => installSkill({ dir })).not.toThrow();
      expect(readFileSync(join(dir, "skills", "openledger", "VERSION"), "utf8").trim()).toBe(
        getVersion(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws SkillPackVersionError on a version clash without --force, succeeds with it", () => {
    const dir = tmp("oled-install-clash-");
    try {
      installSkill({ dir });
      const versionPath = join(dir, "skills", "openledger", "VERSION");
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
let runCli: CliRunner;

beforeAll(() => {
  sandbox = createSandbox("oled-setup-cli-it-");
  runCli = makeRunCli(sandbox);
});

afterAll(() => {
  sandbox.cleanup();
});

describe("setup CLI (subprocess)", () => {
  it(
    "--print emits raw SKILL.md with parseable frontmatter",
    async () => {
      const res = await runCli(["setup", "--print"]);
      expect(res.code).toBe(0);
      expect(res.stdout.startsWith("---\n")).toBe(true);
      const fm = parseFrontmatter(res.stdout);
      expect(fm.name).toBe("openledger");
    },
    30000,
  );

  it(
    "--dir installs the pack and reports it as JSON (kind 'dir')",
    async () => {
      const dir = tmp("oled-cli-install-");
      try {
        const res = await runCli(["setup", "--dir", dir, "--json"]);
        expect(res.code).toBe(0);
        const parsed = JSON.parse(res.stdout.trim());
        expect(parsed.installed[0]).toMatchObject({
          kind: "dir",
          path: join(dir, "skills", "openledger"),
        });
        expect(existsSync(join(dir, "skills", "openledger", "SKILL.md"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30000,
  );

  it(
    "--global installs under the shared home skills dir",
    async () => {
      const res = await runCli(["setup", "--global", "--json"]);
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout.trim());
      const expected = join(sandbox.home, ".agents", "skills", "openledger");
      expect(parsed.installed[0]).toMatchObject({ kind: "agents", path: expected });
      expect(existsSync(join(expected, "SKILL.md"))).toBe(true);
    },
    30000,
  );

  it(
    "an unknown --host fails with USAGE (exit 2) and writes nothing",
    async () => {
      const res = await runCli(["setup", "--host", "bogus", "--json"]);
      expect(res.code).toBe(2);
      const err = JSON.parse(res.stderr.trim());
      expect(err.error.code).toBe("E_USAGE");
    },
    30000,
  );
});
