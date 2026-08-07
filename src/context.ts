import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { tryExecute } from "./lib/result.js";
import { chmod600 } from "./perms.js";

export function readContext(contextPath: string): string {
  if (!existsSync(contextPath)) return "";
  const result = tryExecute(() => readFileSync(contextPath, "utf-8"));
  return result.ok ? result.value : "";
}

function writeContext(contextPath: string, content: string): void {
  const dir = dirname(contextPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(contextPath, content, { encoding: "utf-8", mode: 0o600 });
  chmod600(contextPath);
}

export function createContextTemplate(contextPath: string, userName: string): void {
  if (existsSync(contextPath)) return;
  // Family is for OTHER people; seeding it with the user's own name would let the
  // redactor promote it into a [PARTNER] term and rewrite unrelated text.
  writeContext(
    contextPath,
    `# OpenLedger context for ${userName}\n\n## Family\n(add family members as "- Name (relation)" lines)\n\n## Income\n- (Optional: add your primary income source so OpenLedger can mark it as PII when sending data to the model.)\n\n## Notes\n- (Free-form notes about your accounts, bank preferences, or anything OpenLedger should keep in mind when ingesting.)\n`,
  );
}
