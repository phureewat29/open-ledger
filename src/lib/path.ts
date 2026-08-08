import { homedir } from "os";
import { isAbsolute, resolve, sep } from "path";

/** `/` separates everywhere; `\` also separates on Windows, where it is an
 *  ordinary filename byte on POSIX. */
const TILDE_PREFIXES = process.platform === "win32" ? ["~/", "~\\"] : ["~/"];

/** win32 paths compare case-blind; identity elsewhere. */
const fold =
  process.platform === "win32" ? (s: string) => s.toLowerCase() : (s: string) => s;

/** `~` is the shell's expansion, not Node's, so a quoted `~/x` would otherwise
 *  resolve under the cwd; Windows shells never expand it at all. Inverse of
 *  `homeRelative`, so what `status` prints stays usable as input. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return TILDE_PREFIXES.some((prefix) => path.startsWith(prefix))
    ? resolve(homedir(), path.slice(2))
    : path;
}

/** Collapses a home-rooted path to `~` so output never carries the OS account
 *  name. Only absolute paths are touched, so error prose passes through
 *  unchanged; `resolve` irons the separators and the win32 compare is
 *  case-blind, so a hand-edited `c:/users/...` still relativizes. */
export function homeRelative(p: string): string {
  if (!isAbsolute(p)) return p;
  const abs = resolve(p);
  const prefix = homedir() + sep;
  return fold(abs).startsWith(fold(prefix)) ? "~" + sep + abs.slice(prefix.length) : p;
}
