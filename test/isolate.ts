// Imported first by every test file: indexes go to a throwaway state dir,
// never into the real ~/.local/state/brain of whoever runs the tests.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BRAIN_STATE_DIR = mkdtempSync(join(tmpdir(), "brain-state-"));
