/**
 * Where the skill pack lands. `setup` writes to one directory: the caller's
 * `--dir`, or this default. Callers who know their own agent's skills directory
 * name it explicitly rather than picking a host id from a registry.
 */
export const DEFAULT_SKILLS_DIR = ".agents/skills";

/** The pack's own directory name inside a skills dir; agents discover it by name. */
export const SKILL_PACK_DIR = "openledger";

/**
 * Conventional skills directories `doctor` probes to report an installed pack.
 * A diagnostic guess, not a target: `setup` never resolves a path from this list,
 * so a pack installed elsewhere with `--dir` is simply not found.
 */
export const SKILL_DIRS: readonly string[] = [DEFAULT_SKILLS_DIR, ".claude/skills", ".skills"];
