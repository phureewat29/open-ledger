import { randomBytes } from "crypto";

export function generateKey(): string {
  return randomBytes(32).toString("hex");
}
