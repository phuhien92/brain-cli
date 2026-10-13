#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import { main } from "../dist/src/cli.js";

// `brain log | head` closes the pipe early; that is not an error.
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

process.exitCode = await main(process.argv.slice(2));
