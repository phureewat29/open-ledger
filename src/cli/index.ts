#!/usr/bin/env node
import { buildProgram } from "./program.js";
import { reportParseError } from "./output.js";

// Exit quietly when a downstream pipe closes early (e.g. `oled transactions list --json | head`).
const exitOnEpipe = (err: NodeJS.ErrnoException): void => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
};
process.stdout.on("error", exitOnEpipe);
process.stderr.on("error", exitOnEpipe);

// runAction reports action failures; only commander's parse errors reach here.
try {
  buildProgram().parse();
} catch (err) {
  reportParseError(err);
}
