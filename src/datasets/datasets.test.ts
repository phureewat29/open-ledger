import { describe, it, expect } from "vitest";
import { countryFileSchema } from "./institutions.js";
import { findCountryDefaults, availableCountries } from "./defaults.js";
import { listDatasets, readDataset } from "./index.js";

describe("institutions dataset", () => {
  it("loads every country's file, tagging and sorting rows by country then code", () => {
    const rows = readDataset("institutions");
    const sorted = [...rows].sort(
      (a, b) => a.country.localeCompare(b.country) || String(a.code).localeCompare(String(b.code)),
    );
    expect(rows).toEqual(sorted);

    const countries = new Set(rows.map((r) => r.country));
    expect(countries.has("TH")).toBe(true);
    expect(countries.size).toBeGreaterThan(1);

    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(byCode.get("KBANK")).toMatchObject({ label: "Kasikornbank", kind: "bank", country: "TH" });
    expect(byCode.get("PROMPTPAY")).toMatchObject({ kind: "payment_rail", country: "TH" });
    expect(byCode.get("CHASE")).toMatchObject({ country: "US" });
  });

  it("filters by kind within a country, matching the country case-insensitively", () => {
    const banks = readDataset("institutions", { country: "th", kind: "bank" });
    expect(banks.length).toBeGreaterThan(0);
    expect(banks.every((r) => r.country === "TH" && r.kind === "bank")).toBe(true);
    expect(banks.map((r) => r.code)).toContain("KBANK");
    expect(banks.map((r) => r.code)).not.toContain("BITKUB");
  });

  it("validates a country file's shape, rejecting an unknown kind or a missing field", () => {
    const ok = countryFileSchema.safeParse({
      country: "XX",
      institutions: [{ code: "ACME", label: "Acme Bank", kind: "bank" }],
    });
    expect(ok.success).toBe(true);

    const badKind = countryFileSchema.safeParse({
      country: "XX",
      institutions: [{ code: "ACME", label: "Acme", kind: "not_a_kind" }],
    });
    expect(badKind.success).toBe(false);

    const missingLabel = countryFileSchema.safeParse({
      country: "XX",
      institutions: [{ code: "ACME", kind: "bank" }],
    });
    expect(missingLabel.success).toBe(false);
  });
});

describe("defaults dataset", () => {
  it("returns locale + currency for a known country (case-insensitive)", () => {
    expect(findCountryDefaults("th")).toEqual({ country: "TH", locale: "th-TH", currency: "THB" });
    expect(findCountryDefaults("JP")).toEqual({ country: "JP", locale: "ja-JP", currency: "JPY" });
  });

  it("returns null for an unknown country", () => {
    expect(findCountryDefaults("zz")).toBeNull();
  });

  it("lists the available countries (uppercased, sorted)", () => {
    expect(availableCountries()).toEqual(["CN", "JP", "TH", "US"]);
  });
});

describe("generic dataset surface", () => {
  it("listDatasets summarizes each dataset with its countries and row count", () => {
    const summaries = listDatasets();
    const byName = new Map(summaries.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual(["defaults", "institutions"]);

    const institutions = byName.get("institutions")!;
    expect(institutions.countries).toContain("TH");
    expect(institutions.rows).toBe(readDataset("institutions").length);

    const defaults = byName.get("defaults")!;
    expect(defaults.countries).toEqual(["CN", "JP", "TH", "US"]);
    expect(defaults.rows).toBe(4);
  });

  it("readDataset returns country-tagged rows and honors the country filter", () => {
    const th = readDataset("institutions", { country: "th" });
    expect(th.length).toBeGreaterThan(0);
    expect(th.every((r) => r.country === "TH")).toBe(true);

    const defaults = readDataset("defaults", { country: "us" });
    expect(defaults).toEqual([{ country: "US", locale: "en-US", currency: "USD" }]);
  });

  it("readDataset throws on an unknown dataset name", () => {
    expect(() => readDataset("bogus")).toThrow(/unknown dataset/);
  });
});
