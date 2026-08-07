import type Database from "libsql";

/** Dynamic import keeps libsql's native binding off the startup path of commands that never touch it (see status.ts). */
export async function openDb(dbPath: string): Promise<Database.Database> {
  const { openDb: open } = await import("../db/connection.js");
  return open(dbPath);
}
