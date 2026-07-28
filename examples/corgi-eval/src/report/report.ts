import type { BudgetSource, Modality, ModalitySource } from "../model/capabilities.js";
import type { LedgerProbe } from "../oled/ledger.js";
import type { ExpectedLedger, StatementFacts } from "../statement/truth.js";
import type { RunDiagnosis } from "./diagnosis.js";
import type { RunEvent } from "./events.js";
import type { Scorecard } from "./scorecard.js";
import type { PhaseTranscript } from "./transcript.js";

/**
 * What one run amounts to. This is the JSON file's shape, so a field added here
 * is a field two runs can be diffed on; the renderers decide only what to show.
 */

export interface SetupStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** What the host knew about the model, and how a statement was carried to it. */
interface HostIdentity {
  modalities: Modality[];
  modalitiesSource: ModalitySource;
  /** The model's window, when the endpoint reports one. */
  contextLength: number | null;
  /** How both were arrived at, verbatim. */
  detail: string;
  /** Attachment routes the modalities allow, in the order they are tried. */
  transports: string[];
}

/** The trimmer's limit and where it came from, so any trim traces to a real one. */
interface ContextIdentity {
  budgetTokens: number;
  source: BudgetSource;
  detail: string;
}

/** Everything two runs must be diffable on before their scores can be compared. */
export interface RunIdentity {
  startedAt: string;
  model: string;
  baseUrl: string;
  stream: boolean;
  host: HostIdentity;
  context: ContextIdentity;
  oled: { version: string; tarball: string; fileCount: number };
  skill: { path: string; version: string; sha256: string; length: number };
  /** The adapter appended to the installed SKILL.md, verbatim. */
  environmentAdapter: string;
  tools: ToolSchema[];
  /** sha256 over the tool schemas, so a changed tool surface is one field. */
  toolsSha256: string;
  /** What the ledger must hold: the sum of every seeded statement's facts. */
  expected: ExpectedLedger;
  thresholds: {
    moneyTolerance: number;
    netWorthTolerance: number;
    maxUncategorizedRatio: number;
  };
}

export interface RunReport {
  identity: RunIdentity;
  /** Set when the endpoint itself failed and the walkthrough stopped early. */
  endpointError: string | null;
  setup: SetupStep[];
  /** One entry per seeded statement, in the order they were seeded. */
  statements: StatementFacts[];
  expected: ExpectedLedger;
  ledger: LedgerProbe;
  scorecard: Scorecard;
  /** Never scored: where progress stopped, and what the model asked for and did not get. */
  diagnosis: RunDiagnosis;
  transcript: PhaseTranscript[];
  events: RunEvent[];
}
