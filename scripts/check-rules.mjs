// Checks symbolhop's own rules on its source, for CI: `node scripts/check-rules.mjs`.
// Every file under src is read; anything that doesn't fit the lists below fails the build.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Modules src may import, and which names from each. */
const ALLOWED = {
  "node:fs": ["existsSync", "readdirSync", "readFileSync", "realpathSync", "statSync"],
  "node:path": ["default"],
  "node:url": ["pathToFileURL", "fileURLToPath"],
  "node:child_process": ["spawn"],
};
/** The only file that may start a program. */
const SPAWNS = "src/lsp.js";
/** The LSP messages symbolhop may send or answer: all of them read-only. */
const METHODS = new Set([
  "initialize", "initialized", "shutdown", "exit",
  "textDocument/didOpen", "textDocument/didChange", "textDocument/didClose",
  "textDocument/definition", "textDocument/references", "textDocument/hover", "textDocument/documentSymbol",
  "textDocument/publishDiagnostics", "workspace/configuration", "workspace/workspaceFolders",
]);
const FORBIDDEN = [
  [/\brequire\s*\(|createRequire|\bimport\s*\(/, "loads code at run time"],
  [/\beval\s*\(|new Function\b|process\.(binding|dlopen)|globalThis\[/, "runs code from strings"],
  [/\bfetch\s*\(|WebSocket|XMLHttpRequest|EventSource/, "uses the network"],
  [/shell\s*:\s*true/, "starts a shell"],
  [/`[^`]*(textDocument|workspace)\/\$\{/, "builds an LSP method name"],
];

const problems = [];
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
};
walk("src");

for (const file of files) {
  const relative = file.split(path.sep).join("/");
  if (!/\.js$/.test(file)) {
    problems.push(`${relative}: only .js files belong in src`);
    continue;
  }
  const source = readFileSync(file, "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const match of code.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
    const [, clause = "", from = match[3]] = match;
    if (from.startsWith("./")) continue;
    const allowed = ALLOWED[from];
    if (!allowed) {
      problems.push(`${relative}: imports ${from}`);
      continue;
    }
    if (from === "node:child_process" && relative !== SPAWNS) problems.push(`${relative}: only ${SPAWNS} may start programs`);
    const names = clause.includes("{") ? clause.replace(/^[^{]*\{|\}.*$/gs, "").split(",").map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean) : ["default"];
    if (clause.includes("* as")) names.push("*");
    for (const name of names) if (!allowed.includes(name)) problems.push(`${relative}: imports ${name} from ${from}`);
  }
  for (const [pattern, what] of FORBIDDEN) if (pattern.test(code)) problems.push(`${relative}: ${what}`);
  for (const match of code.matchAll(/["'`]((?:textDocument|workspace|\$|window|notebookDocument)\/[A-Za-z/]+|initialize|initialized|shutdown|exit)["'`]/g)) {
    if (!METHODS.has(match[1])) problems.push(`${relative}: uses the LSP method ${match[1]}`);
  }
  if (relative === SPAWNS && (code.match(/\bspawn\s*\(/g) ?? []).length !== 1) problems.push(`${relative}: should start exactly one kind of program`);
}

if (problems.length) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log(`Checked ${files.length} files: read-only imports, one spawn without a shell, read-only LSP methods, no network.`);
