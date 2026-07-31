import { afterEach, describe, expect, it } from "vitest";
import { config } from "../../config.js";
import { renderTty, type StatusReport } from "./status.js";

const ORIGINAL_LOCALE = config.displayLocale;
const ORIGINAL_CURRENCY = config.displayCurrency;

function report(over: Partial<StatusReport> = {}): StatusReport {
  return {
    type: "status",
    configured: true,
    config_path: "/tmp/none/config.json",
    data_dir: "/tmp/none/data",
    locale: config.displayLocale,
    currency: config.displayCurrency,
    user_name: "User",
    db: { path: "/tmp/none/db.sqlite", reachable: true, error: null },
    counts: { accounts: 1, transactions: 1, merchants: 0, notes: 0 },
    files: null,
    questions: null,
    net_worth: { assets: {}, liabilities: { JPY: 1500 }, net_worth: { JPY: -1500 } },
    ...over,
  };
}

function capture(run: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

describe("renderTty (the only surface that formats money for humans)", () => {
  afterEach(() => {
    config.displayLocale = ORIGINAL_LOCALE;
    config.displayCurrency = ORIGINAL_CURRENCY;
  });

  it("renders a negative net worth signed, in the currency's own fraction digits", () => {
    config.displayLocale = "ja-JP";
    config.displayCurrency = "JPY";

    const out = capture(() => renderTty(report(), false));

    // JPY has no minor unit: 1,500 exactly, never 1,500.00.
    expect(out).toContain("1,500");
    expect(out).not.toMatch(/1,500\.0/);
    // A ledger in net debt must read as debt.
    expect(out).toMatch(/-[^\d]*1,500/);
  });

  it("gives every ledger its own labelled rows, each in its own currency", () => {
    // The display currency is THB; the JPY figures must not borrow its exponent.
    config.displayLocale = "en-US";
    config.displayCurrency = "THB";

    const out = capture(() =>
      renderTty(
        report({
          net_worth: {
            assets: { JPY: 1500, THB: 20.5 },
            liabilities: {},
            net_worth: { JPY: 1500, THB: 20.5 },
          },
        }),
        false,
      ),
    );

    expect(out).toMatch(/JPY net worth\s+¥1,500\n/);
    expect(out).toMatch(/THB net worth\s+THB 20\.50\n/);
    // Ledgers sort by ISO code, and neither total is folded into the other.
    expect(out.indexOf("JPY net worth")).toBeLessThan(out.indexOf("THB net worth"));
    expect(out).not.toContain("1,520");
  });

  it("points a missing ledger at config --init, and an unopenable one at doctor", () => {
    const unreachable = report({
      db: { path: "/tmp/none/db.sqlite", reachable: false, error: "no ledger yet" },
      counts: null,
      net_worth: null,
    });

    const missing = capture(() => renderTty(unreachable, false, true));
    expect(missing).toContain("oled config --init");

    // An existing-but-unopenable db is a diagnosis job, not an init job.
    const corrupt = capture(() => renderTty(unreachable, false, false));
    expect(corrupt).toContain("oled doctor");
  });
});
