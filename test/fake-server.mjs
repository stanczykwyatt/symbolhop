// A misbehaving language server for tests: `closestdin` stops reading at once, `junk` prints a flood
// that isn't LSP. Only ever started by the tests.
import { readFileSync } from "node:fs";
const mode = process.argv[2];
if (mode === "closestdin") process.stdin.destroy();
if (mode === "junk") {
  process.stdout.write("x".repeat(64 * 1024));
  setInterval(() => {}, 1000);
}
process.stdin.on("data", () => {});
void readFileSync;
