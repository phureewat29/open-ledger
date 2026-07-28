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

// Actions report their own failures inside runAction; only commander's parse
// errors reach here, thrown by the exit override wired in buildProgram().
try {
  buildProgram().parse();
} catch (err) {
  reportParseError(err);
}
