// Measures what an agent gets back when it looks for a symbol's uses: `grep -rn NAME`, `grep -rnw NAME`
// (whole words), or symbolhop's lsp_references. On a made-up C project generated here, so the numbers
// can be rerun by anyone: `node bench/measure.mjs` (needs clangd). The true uses are written down while
// the project is generated, so every tool, symbolhop included, is graded against the same list.
// Tokens are estimated as characters / 4.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Workspace } from "../src/tools.js";

const root = mkdtempSync(path.join(tmpdir(), "symbolhop-bench-"));
mkdirSync(path.join(root, "src"));
writeFileSync(path.join(root, "compile_flags.txt"), "-xc\n-std=c11\n-Isrc\n");

// A project shaped like real C: a shared header, and modules that each have a `count` field, local
// variables called count, helpers with names that start the same, and comments and log messages
// that mention the functions by name.
const modules = 24;
// The true uses, by "file:line", for each symbol asked about.
const truth = {
  count_entries: new Set(["src/app.h:6", "src/core.c:5"]),
  init: new Set(["src/app.h:8", "src/core.c:14"]),
  count: new Set(["src/app.h:4"]),
};
let header = "#ifndef APP_H\n#define APP_H\n\nstruct stats { int count; int total; };\n\nint count_entries(const char *list);\nint count_entries_fast(const char *list);\nvoid init(void);\nvoid init_logging(void);\n";
for (let m = 0; m < modules; m++) header += `int module${m}_run(struct stats *s);\n`;
writeFileSync(path.join(root, "src/app.h"), header + "\n#endif\n");
writeFileSync(path.join(root, "src/core.c"), `#include <string.h>
#include "app.h"

/* count_entries: how many comma-separated entries are in a list. */
int count_entries(const char *list) {
    int count = 1;
    for (const char *p = list; *p; p++) if (*p == ',') count++;
    return count;
}

int count_entries_fast(const char *list) { return (int)strlen(list) / 2; }

void init_logging(void) {}
void init(void) { init_logging(); }
`);
for (let m = 0; m < modules; m++) {
  const useEntries = m % 3 === 0;
  const file = `src/module${m}.c`;
  truth.init.add(`${file}:7`);
  for (const line of [9, 10, 12]) truth.count.add(`${file}:${line}`);
  if (useEntries) truth.count_entries.add(`${file}:11`);
  writeFileSync(path.join(root, `src/module${m}.c`), `#include <stdio.h>
#include "app.h"

/* Module ${m}. Calls init first; see count_entries for how lists are counted. */
int module${m}_run(struct stats *s) {
    int count = 0;
    init();
    for (int i = 0; i < ${m + 2}; i++) count += i;
    s->count = count;
    s->total += s->count;
${useEntries ? `    s->total += count_entries("a,b,c");\n` : `    s->total += count_entries_fast("a,b,c");\n`}    printf("module ${m}: count=%d (count_entries %s)\\n", s->count, "${useEntries ? "used" : "not used"}");
    return count;
}
`);
}

const ws = new Workspace(root);
const queries = [
  { name: "count_entries", file: "src/core.c", line: 5, what: "a function (one of two with the same prefix)" },
  { name: "init", file: "src/core.c", line: 14, what: "a short function name" },
  { name: "count", file: "src/app.h", line: 4, what: "a struct field that shares its name with local variables" },
];
const rows = [];
const key = (line) => line.split(":").slice(0, 2).join(":");
const grade = (query, tool, lines, text) => {
  const found = new Set(lines.map(key));
  const right = [...found].filter((k) => truth[query.name].has(k)).length;
  rows.push({
    query: `${query.name}: ${query.what}`, tool, lines: lines.length,
    wrong: lines.filter((l) => !truth[query.name].has(key(l))).length,
    missed: truth[query.name].size - right, tokens: Math.round(text.length / 4),
  });
};
for (const q of queries) {
  for (const [label, flags] of [["grep -rn", ["-rn"]], ["grep -rnw", ["-rnw"]]]) {
    let out = "";
    try {
      out = execFileSync("grep", [...flags, q.name, "src"], { cwd: root, encoding: "utf8" });
    } catch (e) {
      out = e.stdout ?? "";
    }
    grade(q, label, out.split("\n").filter(Boolean), out);
  }
  const answer = await ws.references({ file: q.file, line: q.line, symbol: q.name });
  grade(q, "lsp_references", answer.split("\n").filter((l) => /:\d+:\d+/.test(l)), answer);
}
await ws.stop();
rmSync(root, { recursive: true });

console.log(`Made-up C project: ${modules + 1} source files and a header, clangd ${execFileSync("clangd", ["--version"], { encoding: "utf8" }).match(/\d+\.\d+\.\d+/)?.[0]}.\n`);
console.log("| Looking for | With | Lines back | Not a use | Uses missed | ~Tokens |");
console.log("|---|---|---:|---:|---:|---:|");
for (const r of rows) console.log(`| ${r.query} | \`${r.tool}\` | ${r.lines} | ${r.wrong} | ${r.missed} | ${r.tokens} |`);
const ratios = queries.map((q) => {
  const mine = rows.find((r) => r.query.startsWith(q.name + ":") && r.tool === "lsp_references").tokens;
  const theirs = rows.filter((r) => r.query.startsWith(q.name + ":") && r.tool !== "lsp_references").map((r) => r.tokens);
  return [Math.min(...theirs) / mine, Math.max(...theirs) / mine];
});
console.log(`\nTokens, grep divided by lsp_references, per question: ${ratios.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)}×`).join(", ")}.`);
