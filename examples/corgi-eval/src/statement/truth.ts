import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as z from "zod";
import { tryExecute, type Result } from "../core/result.js";

/**
 * What each statement says, read from the PDF once and checked in beside it as
 * fact. Reading a statement is the model's job, through oled; fact files never
 * enter the sandbox, so they cannot leak the answers.
 */

const GROUP = z.object({
  count: z.number().int().nonnegative(),
  /** Absolute total, so a refund or a payment is a positive number here. */
  total: z.number().nonnegative(),
});

const FACTS = z.object({
  /** The PDF this file describes; checked against the file it was loaded for. */
  statement: z.string().min(1),
  currency: z.string().min(1),
  note: z.string().min(1),
  groups: z.object({ charges: GROUP, refunds: GROUP, payments: GROUP }),
  summary: z.object({
    previousBalance: z.number(),
    purchasesAndFees: z.number(),
    refundsAndCredits: z.number(),
    paymentsReceived: z.number(),
    totalAmountDue: z.number(),
    outstandingPoints: z.number().int(),
    cardNumber: z.string().min(1),
    statementDate: z.string().min(1),
    paymentDueDate: z.string().min(1),
  }),
});

export type StatementFacts = z.infer<typeof FACTS>;
export type StatementGroup = z.infer<typeof GROUP>;

/** What the ledger must hold once every seeded statement is ingested. */
export interface ExpectedLedger {
  currency: string;
  rows: number;
  charges: number;
  refunds: number;
  payments: number;
}

const PDF_SUFFIX = /\.pdf$/i;

/** The 1-1 link: `card-statement-2026-05.pdf` → `card-statement-2026-05.expected.json`. */
function factsPathFor(pdfPath: string): string {
  return `${pdfPath.replace(PDF_SUFFIX, "")}.expected.json`;
}

// Money is compared in minor units: the fact files are decimal, and 0.1 + 0.2 is not 0.3.
function minor(amount: number): number {
  return Math.round(amount * 100);
}

function rowsIn(facts: StatementFacts): number {
  const { charges, refunds, payments } = facts.groups;
  return charges.count + refunds.count + payments.count;
}

/**
 * Every way one statement's groups and its own summary box can disagree. The
 * closing balance is the arithmetic that ties them together, so it is checked too.
 */
function reconcile(facts: StatementFacts): string[] {
  const { charges, refunds, payments } = facts.groups;
  const box = facts.summary;
  const disagreements: string[] = [];
  const compare = (label: string, group: number, stated: number): void => {
    if (minor(group) === minor(stated)) return;
    disagreements.push(`${label}: groups say ${group.toFixed(2)}, the box says ${stated.toFixed(2)}`);
  };

  compare("charges", charges.total, box.purchasesAndFees);
  compare("refunds", refunds.total, box.refundsAndCredits);
  compare("payments", payments.total, box.paymentsReceived);

  const due =
    minor(box.previousBalance) + minor(charges.total) - minor(refunds.total) - minor(payments.total);
  if (due !== minor(box.totalAmountDue)) {
    disagreements.push(
      `total amount due: the rows add up to ${(due / 100).toFixed(2)}, the box says ${box.totalAmountDue.toFixed(2)}`,
    );
  }
  return disagreements;
}

function loadStatementFacts(pdfPath: string): Result<StatementFacts> {
  const path = factsPathFor(pdfPath);
  const read = tryExecute(() => readFileSync(path, "utf8"));
  if (!read.ok) return { ok: false, error: `cannot read ${path}: ${read.error}` };

  const json = tryExecute(() => JSON.parse(read.value) as unknown);
  if (!json.ok) return { ok: false, error: `${path} is not valid JSON: ${json.error}` };

  const parsed = FACTS.safeParse(json.value);
  if (!parsed.success) return { ok: false, error: `${path}: ${z.prettifyError(parsed.error)}` };

  const facts = parsed.data;
  const pdf = basename(pdfPath);
  if (facts.statement !== pdf) {
    return { ok: false, error: `${path} describes ${facts.statement}, not ${pdf}` };
  }

  const disagreements = reconcile(facts);
  if (disagreements.length > 0) {
    return { ok: false, error: `${path} disagrees with itself: ${disagreements.join("; ")}` };
  }
  return { ok: true, value: facts };
}

export function loadEveryStatement(pdfPaths: string[]): Result<StatementFacts[]> {
  const loaded: StatementFacts[] = [];
  for (const path of pdfPaths) {
    const facts = loadStatementFacts(path);
    if (!facts.ok) return facts;
    loaded.push(facts.value);
  }
  if (loaded.length === 0) return { ok: false, error: "no statements to score against" };
  return { ok: true, value: loaded };
}

/** One statement or ten: the run is scored against the sum of their facts. */
export function expectLedger(every: StatementFacts[]): ExpectedLedger {
  const sum = (pick: (facts: StatementFacts) => number): number =>
    every.reduce((total, facts) => total + minor(pick(facts)), 0) / 100;
  return {
    currency: every[0]?.currency ?? "",
    rows: every.reduce((total, facts) => total + rowsIn(facts), 0),
    charges: sum((facts) => facts.groups.charges.total),
    refunds: sum((facts) => facts.groups.refunds.total),
    payments: sum((facts) => facts.groups.payments.total),
  };
}
