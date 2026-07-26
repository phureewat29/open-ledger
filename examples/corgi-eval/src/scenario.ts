import type { PhaseId } from "./report/events.js";

export interface Phase {
  id: PhaseId;
  title: string;
  prompt: string;
}

export const STATEMENT_PASSWORD = "password";

/** Statements a run seeds, from `fixtures/`; each `<name>.pdf` has a `<name>.expected.json` beside it. */
export const STATEMENT_FIXTURES = ["card-statement-2026-05.pdf"];

/** One continuous conversation: the phases share a message history. */
export const SCENARIO: Phase[] = [
  {
    id: "orient",
    title: "Orient",
    prompt: "Show me the current state of my ledger.",
  },
  {
    id: "ingest",
    title: "Ingest",
    prompt: `Ingest my new statements, every row on the statement. It is password-protected; the password is: ${STATEMENT_PASSWORD}. Tell me how many rows you posted when you are done.`,
  },
  {
    id: "resolve",
    title: "Resolve",
    prompt: "Walk me through anything you weren't sure about and resolve what you can.",
  },
  {
    id: "answer",
    title: "Answer",
    prompt:
      "What did I spend the most on in May 2026, and what is my net worth? Answer briefly.",
  },
];

/** Recorded verbatim in the report, so a score is always readable against the prompt that produced it. */
/**
 * Environment facts the model cannot infer, and nothing else. Every rule about
 * using plasalid is deliberately absent: SKILL.md and `plasalid <noun> --help`
 * are the surface under test, so repeating their advice here would measure this
 * text instead of the harness.
 */
export const ENVIRONMENT_ADAPTER = `## This environment

- You have one tool, \`plasalid\`, and no filesystem: one command per call, no shell operators, and no way to create or read files yourself.
- Whatever a command produces for you to read is delivered into this conversation automatically.
- Whatever a command would read from stdin goes in the tool's \`stdin\` field.
- Keep replies short. This run scores your actions, not your prose.`;

export function buildSystemPrompt(skillMd: string): string {
  return `${skillMd.trim()}\n\n${ENVIRONMENT_ADAPTER}\n`;
}
