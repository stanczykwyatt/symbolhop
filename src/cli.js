#!/usr/bin/env node
// symbolhop: go-to-definition, references, hover, diagnostics and outlines for coding agents, from
// the language servers you already have. `symbolhop serve` is the MCP server; the other commands
// print the same answers in a terminal.
import path from "node:path";
import { serve } from "./mcp.js";
import { Workspace, ToolError, SERVERS, which } from "./tools.js";

const USAGE = `symbolhop 0.1.0: exact code navigation for coding agents, from your language servers

  symbolhop serve [--root DIR]                   run the MCP server on stdin and stdout
  symbolhop def   FILE LINE SYMBOL [--root DIR]  where SYMBOL on LINE is defined
  symbolhop refs  FILE LINE SYMBOL [--root DIR]  every use of it
  symbolhop hover FILE LINE SYMBOL [--root DIR]  its type and documentation
  symbolhop diag  FILE [--root DIR]              errors and warnings in FILE
  symbolhop outline FILE [--root DIR]            the symbols in FILE
  symbolhop doctor                               which language servers it can find

LINE is 1-based. SYMBOL can also be a column number. The project folder defaults to the current one.
--languages c,typescript,…  chooses which language servers may run. By default: c, typescript, python,
go, rust, swift and lua. java, ruby and zig run the project's build files, so they must be asked for.`;

const args = process.argv.slice(2);
let root = process.cwd();
const rootAt = args.indexOf("--root");
if (rootAt >= 0) {
  root = path.resolve(args[rootAt + 1] ?? ".");
  args.splice(rootAt, 2);
}
let languages;
const languagesAt = args.indexOf("--languages");
if (languagesAt >= 0) {
  languages = (args[languagesAt + 1] ?? "").split(",").map((l) => l.trim()).filter(Boolean);
  args.splice(languagesAt, 2);
}
const [command, file, lineText, symbol] = args;

async function main() {
  if (command === "serve") return serve(root, { languages });
  if (command === "doctor") {
    for (const [family, candidates] of Object.entries(SERVERS)) {
      const found = candidates.map((c) => which(c[0])).find(Boolean);
      console.log(`${family.padEnd(11)} ${found ?? `not found (install ${candidates.map((c) => c[0]).join(" or ")})`}`);
    }
    return;
  }
  if (command === "--version" || command === "-v") return console.log("0.1.0");
  const workspace = new Workspace(root, languages ? { languages } : {});
  const line = Number(lineText);
  const at = /^\d+$/.test(symbol ?? "") ? { column: Number(symbol) } : { symbol };
  const run = {
    def: () => workspace.definition({ file, line, ...at }),
    refs: () => workspace.references({ file, line, ...at }),
    hover: () => workspace.hover({ file, line, ...at }),
    diag: () => workspace.diagnostics({ file }),
    outline: () => workspace.symbols({ file }),
  }[command];
  if (!run) {
    console.log(USAGE);
    process.exitCode = command && !["help", "-h", "--help"].includes(command) ? 2 : 0;
    return;
  }
  try {
    console.log(await run());
  } catch (e) {
    console.error(e instanceof ToolError ? e.message : `symbolhop: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await workspace.stop();
    process.exit();
  }
}

main();
