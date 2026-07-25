import { homedir } from "os";
import { resolve } from "path";

/** A host is nothing but the directory it reads skills from — pure data. */
export interface SkillHost {
  /** Registry id and `--host` value. */
  id: string;
  label: string;
  /** Skills dir relative to the cwd, e.g. ".claude/skills". */
  projectDir: string;
  /** Absolute skills dir under home; a function because some globals don't mirror projectDir. */
  globalDir(): string;
}

// Any coding agent compatible with the shared .agents/skills dir (Codex,
// OpenCode, Pi, Kimi global, …) is served by this default entry; only hosts
// that cannot read it get their own.
const agents: SkillHost = {
  id: "agents",
  label: "Agent Skills standard directory",
  projectDir: ".agents/skills",
  globalDir: () => resolve(homedir(), ".agents/skills"),
};

const claude: SkillHost = {
  id: "claude",
  label: "Claude Code",
  projectDir: ".claude/skills",
  globalDir: () => resolve(homedir(), ".claude/skills"),
};

// Kimi's project dir is its own .skills; its global reads the shared
// ~/.agents/skills, so the global install goes there.
const kimi: SkillHost = {
  id: "kimi",
  label: "Kimi",
  projectDir: ".skills",
  globalDir: () => resolve(homedir(), ".agents/skills"),
};

export const SKILL_HOSTS: SkillHost[] = [agents, claude, kimi];

export const DEFAULT_HOST = agents.id;

/** Look up a host by its `--host` id, or null when it isn't a known host. */
export function findHost(id: string): SkillHost | null {
  return SKILL_HOSTS.find((h) => h.id === id) ?? null;
}
