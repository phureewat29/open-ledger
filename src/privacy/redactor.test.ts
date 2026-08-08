import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { applyRedaction, type RedactionSource } from "./redactor.js";

let dir: string;
let SOURCE: RedactionSource;

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), "oled-redactor-"));
  const contextPath = resolve(dir, "context.md");
  writeFileSync(
    contextPath,
    `## Family
- Partner: Corgi
- User

## Income
- 80,000 THB/month from Zentry Thailand Co.
`,
  );
  SOURCE = { userName: "Alpaca Beagle", contextPath };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// createRedactor is private; exercised here through applyRedaction, round-tripping a single allowlisted field.
function redact(text: string): string {
  return applyRedaction({ text }, true, ["text"], SOURCE).text;
}

describe("applyRedaction (masking patterns)", () => {
  it("redacts user full name", () => {
    expect(redact("Alpaca Beagle sent 1,000 baht")).toBe("[USER] sent 1,000 baht");
  });

  it("redacts user first and last names", () => {
    expect(redact("Hi Alpaca, Mr. Beagle")).toBe("Hi [USER_FIRST], Mr. [USER_LAST]");
  });

  it("matches terms literally, never as regex patterns", () => {
    // "Zentry Thailand Co." ends in a regex special; unescaped, the dot would also match "CoX".
    expect(redact("Zentry Thailand CoX invoice")).toBe("Zentry Thailand CoX invoice");
  });

  it("redacts employer", () => {
    expect(redact("Salary from Zentry Thailand Co.")).toBe(
      "Salary from [EMPLOYER]",
    );
  });

  it("redacts Thai national ID with dashes", () => {
    expect(redact("ID: 1-2345-67890-12-3")).toBe("ID: [NATID]");
  });

  it("redacts Thai national ID without dashes", () => {
    expect(redact("ID 1234567890123 issued")).toBe("ID [NATID] issued");
  });

  it("redacts Thai mobile numbers", () => {
    expect(redact("Call 0812345678 for assistance")).toBe(
      "Call [PHONE] for assistance",
    );
  });

  it("redacts 16-digit credit card numbers", () => {
    expect(redact("Card 4111 1111 1111 1111")).toBe("Card [CARD]");
  });

  it("leaves clean text alone", () => {
    expect(redact("The weather is hot in Bangkok today")).toBe(
      "The weather is hot in Bangkok today",
    );
  });

  it("never rewrites a path: the default name is not a term, and terms respect boundaries", () => {
    // The context's Family section carries "- User", which must not become a term.
    expect(redact("/Users/phureewat/.oled/db.sqlite")).toBe("/Users/phureewat/.oled/db.sqlite");
  });

  it("redacts a partner name from context, whole words only: Corgi inside Corgis stays put", () => {
    expect(redact("Payment to Corgi")).toBe("Payment to [PARTNER]");
    expect(redact("Corgis are a breed")).toBe("Corgis are a breed");
  });
});

describe("applyRedaction (field allowlisting)", () => {
  it("is an identity no-op when disabled", () => {
    const data = { memo: "call 0812345678", account_id: "asset:kbank" };
    expect(applyRedaction(data, false, ["memo"], SOURCE)).toBe(data);
  });

  it("redacts allowlisted string fields but leaves other fields verbatim", () => {
    const row = {
      account_id: "asset:0812345678", // would match [PHONE] but is NOT allowlisted
      memo: "refund to 0812345678",
      currency: "THB",
    };
    const out = applyRedaction(row, true, ["memo"], SOURCE);
    expect(out.memo).toBe("refund to [PHONE]");
    // ids/enums must survive untouched even when they contain digits.
    expect(out.account_id).toBe("asset:0812345678");
    expect(out.currency).toBe("THB");
  });

  it("deep-walks nested objects and arrays", () => {
    const detail = {
      id: "e:1",
      description: "salary 1-2345-67890-12-3",
      entries: [
        { id: "e:2", account_id: "asset:kbank", memo: "card 4111 1111 1111 1111" },
        { id: "e:3", account_id: "expense:food", memo: null },
      ],
    };
    const out = applyRedaction(detail, true, ["description", "memo"], SOURCE);
    expect(out.description).toBe("salary [NATID]");
    expect(out.entries[0].memo).toBe("card [CARD]");
    expect(out.entries[0].account_id).toBe("asset:kbank");
    expect(out.entries[1].memo).toBeNull();
    expect(out.id).toBe("e:1");
  });

  it("does not mutate the input", () => {
    const row = { memo: "0812345678" };
    const out = applyRedaction(row, true, ["memo"], SOURCE);
    expect(row.memo).toBe("0812345678");
    expect(out.memo).toBe("[PHONE]");
  });

  it("reads sections from a CRLF context.md (Windows line endings)", () => {
    const contextPath = resolve(dir, "context-crlf.md");
    writeFileSync(
      contextPath,
      "## Family\r\n- Partner: Corgi\r\n\r\n## Income\r\n- 80,000 THB/month from Zentry Thailand Co.\r\n",
    );
    const source = { userName: "Alpaca Beagle", contextPath };
    const out = applyRedaction({ text: "Corgi paid Zentry Thailand Co." }, true, ["text"], source);
    expect(out.text).toBe("[PARTNER] paid [EMPLOYER]");
  });
});
