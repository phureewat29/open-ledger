/** Default skills dir `setup` writes to when no `--dir` is given; callers name their own dir rather than picking a host id from a registry. */
export const DEFAULT_SKILLS_DIR = ".agents/skills";

/** The pack's own directory name inside a skills dir; agents discover it by name. */
export const SKILL_PACK_DIR = "openledger";

/** Directories `doctor` probes for an installed pack; diagnostic only, `setup` never resolves a path from here. */
export const SKILL_DIRS: readonly string[] = [DEFAULT_SKILLS_DIR, ".claude/skills", ".skills"];
