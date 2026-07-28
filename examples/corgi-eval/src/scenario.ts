import type { PhaseId } from "./report/events.js";

export interface Phase {
  id: PhaseId;
  title: string;
  prompt: string;
}

const STATEMENT_PASSWORD = "password";

/** Statements a run seeds, from `fixtures/`; each `<name>.pdf` has a `<name>.expected.json` beside it. */
export const STATEMENT_FIXTURES = ["card-statement-2026-05.pdf"];

// One continuous conversation: the phases share a message history; prompts
// ask for exactly what scoring needs (password used, rows posted).
export const SCENARIO: Phase[] = [
  {
    id: "ingest",
    title: "Ingest",
    prompt: `Ingest my new statements. The statement is password-protected; the password is: ${STATEMENT_PASSWORD}. Tell me how many rows you posted when you are done.`,
  },
  {
    id: "resolve",
    title: "Resolve",
    prompt: "Show me anything you weren't sure about, and let's resolve it.",
  },
  {
    id: "answer",
    title: "Answer",
    prompt: "What's my net worth, and where did most of my spending go in May 2026? Answer briefly.",
  },
];

/**
 * Environment facts the model cannot infer, and nothing else. Usage rules for
 * `oled` are deliberately absent — SKILL.md and `--help` are the surface under
 * test, so repeating their advice here would measure this text instead.
 */
export const ENVIRONMENT_ADAPTER = `## This environment

- You have one tool, \`oled\`, and no filesystem: no shell operators, and no way to create or read files yourself.
- Whatever a command produces for you to read is delivered into this conversation automatically.
- Whatever a command would read from stdin goes in the tool's \`stdin\` field.
- Keep replies short. This run scores your actions, not your prose.`;

export function buildSystemPrompt(skillMd: string): string {
  return `${skillMd.trim()}\n\n${ENVIRONMENT_ADAPTER}\n`;
}
