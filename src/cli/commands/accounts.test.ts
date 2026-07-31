import { describe, it, expect, beforeEach } from "vitest";
import type Database from "libsql";
import { createOneAccount } from "./accounts.js";
import { findAccountById } from "../../db/queries/accounts.js";
import { failingAccountInsert, freshDb } from "../../../fixtures/db.js";

// createOneAccount unwraps RefusedCreate but must not treat any other throw as a refusal:
// a broken database would otherwise misread as "account already exists".
describe("createOneAccount refusal carrier", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("lets a broken write escape instead of reporting it as a refusal", () => {
    // The account INSERT fails the way a full disk would; every other statement still works.
    const broken = failingAccountInsert(db, "thb:asset:bank");

    expect(() =>
      createOneAccount(broken, { id: "thb:asset:bank", name: "KBank Savings", type: "asset" }),
    ).toThrow(/disk I\/O/);

    // The whole chain is one transaction: the ledger root it opened must not outlive the leaf.
    expect(findAccountById(db, "thb:asset:bank")).toBeNull();
    expect(findAccountById(db, "thb:asset")).toBeNull();
  });

  it("still reports a taken id as data, not as a throw", () => {
    const first = createOneAccount(db, { id: "thb:asset:bank", name: "KBank", type: "asset" });
    expect(first).toMatchObject({ ok: true, id: "thb:asset:bank" });

    expect(createOneAccount(db, { id: "thb:asset:bank", name: "KBank", type: "asset" })).toEqual({
      ok: false,
      reason: "account_exists",
      message: expect.any(String),
    });
  });
});
