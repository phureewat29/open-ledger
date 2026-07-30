import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { dirname, resolve } from "path";
import { getOledDir } from "./config.js";
import { tryExecute } from "./lib/result.js";

export function getContextPath(): string {
  return resolve(getOledDir(), "context.md");
}

export function readContext(): string {
  const p = getContextPath();
  if (!existsSync(p)) return "";
  const result = tryExecute(() => readFileSync(p, "utf-8"));
  return result.ok ? result.value : "";
}

function writeContext(content: string): void {
  const p = getContextPath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, content, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
}

export function createContextTemplate(userName: string): void {
  if (existsSync(getContextPath())) return;
  // Family is for OTHER people; seeding it with the user's own name would let the
  // redactor promote that name into a [PARTNER] term and rewrite it inside
  // unrelated text (e.g. a "User" match inside a file path).
  writeContext(
    `# OpenLedger context for ${userName}\n\n## Family\n(add family members as "- Name (relation)" lines)\n\n## Income\n- (Optional: add your primary income source so OpenLedger can mark it as PII when sending data to the model.)\n\n## Notes\n- (Free-form notes about your accounts, bank preferences, or anything OpenLedger should keep in mind when ingesting.)\n`,
  );
}
