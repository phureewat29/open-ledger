import type Database from "libsql";
import * as baseline from "./0001_baseline.js";

/** A forward migration. Its position in MIGRATIONS is its version (index 0 = v1). */
export interface Migration {
  up(db: Database.Database): void;
}

/**
 * The ordered migration manifest, written out explicitly: no fs glob, no
 * dynamic import, so the bare `tsc` build ships nothing extra to dist/ and the
 * list type-checks. Append new migrations to the end; never reorder or remove.
 */
export const MIGRATIONS: Migration[] = [baseline];
