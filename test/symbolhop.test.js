// symbolhop's tests: `node --test test/`. The live ones use clangd on a made-up C project and are
// skipped where clangd isn't installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { Framer, frame, languageOf } from "../src/lsp.js";
import { Workspace, ToolError, columnOf, which, projectFiles, formatLocation } from "../src/tools.js";
import { handle, TOOLS, VERSIONS } from "../src/mcp.js";

const fixture = path.resolve("test/fixtures/c-project");
const hasClangd = Boolean(which("clangd"));
const live = { skip: hasClangd ? false : "clangd isn't installed" };

test("LSP messages are framed and unframed, even split across chunks", () => {
  const got = [];
  const framer = new Framer((m) => got.push(m));
  const bytes = Buffer.concat([frame({ id: 1, result: "é" }), frame({ method: "x" })]);
  for (let i = 0; i < bytes.length; i += 7) framer.push(bytes.subarray(i, i + 7));
  assert.deepEqual(got, [{ id: 1, result: "é" }, { method: "x" }]);
});

test("junk between messages is skipped, and huge ones are refused", () => {
  const got = [];
  const framer = new Framer((m) => got.push(m));
  framer.push(Buffer.from("garbage\r\n\r\n"));
  framer.push(Buffer.from("Content-Length: 3\r\n\r\n{x}"));
  framer.push(frame({ ok: true }));
  assert.deepEqual(got, [{ ok: true }]);
  assert.throws(() => new Framer(() => {}).push(Buffer.from("Content-Length: 999999999\r\n\r\n")));
});

test("languages by extension", () => {
  assert.equal(languageOf("a/b.ts").family, "typescript");
  assert.equal(languageOf("x.PY").family, "python");
  assert.equal(languageOf("x.h").family, "c");
  assert.equal(languageOf("Makefile"), null);
});

test("symbols are found as whole words on a line", () => {
  assert.equal(columnOf("  if (parse_config(a) != parse_config_file(b))", "parse_config"), 6);
  assert.equal(columnOf("a.get(); getAll(); get()", "get", 2), 19);
  assert.equal(columnOf("$el = el", "el"), 6);
  assert.equal(columnOf("nothing here", "missing"), null);
  assert.equal(columnOf("ab", "b"), null);
});

test("locations are one short line each, relative to the project", () => {
  assert.equal(formatLocation("/p", "/p/src/a.c", { start: { line: 2, character: 4 } }, ["", "", "    call();  "]), "src/a.c:3:5  call();");
});

test("files outside the project are refused, through links too", () => {
  const root = mkdtempSync(path.join(tmpdir(), "symbolhop-"));
  const outside = mkdtempSync(path.join(tmpdir(), "symbolhop-outside-"));
  writeFileSync(path.join(outside, "secret.c"), "int secret;\n");
  writeFileSync(path.join(root, "ok.c"), "int ok;\n");
  symlinkSync(path.join(outside, "secret.c"), path.join(root, "link.c"));
  const ws = new Workspace(root);
  assert.equal(path.basename(ws.resolve("ok.c")), "ok.c");
  for (const bad of ["../" + path.basename(outside) + "/secret.c", path.join(outside, "secret.c"), "link.c", "", "a\0b", "missing.c", "."]) {
    assert.throws(() => ws.resolve(bad), ToolError, bad);
  }
  rmSync(root, { recursive: true });
  rmSync(outside, { recursive: true });
});

test("positions: by symbol, by column, and helpful mistakes", () => {
  const ws = new Workspace(fixture);
  const file = ws.resolve("src/main.c");
  assert.deepEqual(ws.position(file, { line: 14, symbol: "parse_config" }), { line: 13, character: 12 });
  assert.deepEqual(ws.position(file, { line: 14, column: 13 }), { line: 13, character: 12 });
  assert.throws(() => ws.position(file, { line: 14, symbol: "nope" }), /isn't on line 14/);
  assert.throws(() => ws.position(file, { line: 999, symbol: "x" }), /isn't in src\/main.c/);
  assert.throws(() => ws.position(file, { line: 14 }), /Give a symbol name/);
});

test("project files skip hidden and build folders", () => {
  const root = mkdtempSync(path.join(tmpdir(), "symbolhop-"));
  for (const dir of ["src", ".git", "node_modules/x", "build"]) mkdirSync(path.join(root, dir), { recursive: true });
  for (const f of ["src/a.c", ".git/b.c", "node_modules/x/c.c", "build/d.c", "e.py"]) writeFileSync(path.join(root, f), "");
  assert.deepEqual(projectFiles(root, "c").map((f) => path.relative(root, f)), ["src/a.c"]);
  assert.equal(projectFiles(root, "c", { maxFiles: 0 }).length, 0);
  rmSync(root, { recursive: true });
});

test("a missing language server is a clear tool error", async () => {
  const ws = new Workspace(fixture, { env: { PATH: "/nonexistent" } });
  await assert.rejects(ws.definition({ file: "src/main.c", line: 14, symbol: "parse_config" }), /No c language server found on PATH/);
});

test("MCP: initialize negotiates the version", async () => {
  const ws = new Workspace(fixture);
  for (const asked of [...VERSIONS, "1999-01-01", undefined]) {
    const response = await handle(ws, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: asked } });
    assert.equal(response.result.protocolVersion, VERSIONS.includes(asked) ? asked : VERSIONS[0]);
    assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  }
});

test("MCP: tools, notifications and errors", async () => {
  const ws = new Workspace(fixture);
  const list = await handle(ws, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["lsp_definition", "lsp_references", "lsp_hover", "lsp_diagnostics", "lsp_symbols"]);
  for (const tool of TOOLS) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(await handle(ws, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await handle(ws, { jsonrpc: "2.0", id: 3, method: "nope" })).error.code, -32601);
  assert.equal((await handle(ws, { id: 4, method: "x" })).error.code, -32600);
  assert.equal((await handle(ws, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf" } })).error.code, -32602);
  const outside = await handle(ws, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "lsp_definition", arguments: { file: "/etc/hosts", line: 1, symbol: "x" } } });
  assert.equal(outside.result.isError, true);
  assert.match(outside.result.content[0].text, /outside the project/);
});

test("live: definition, references, hover, diagnostics and outline from clangd", live, async () => {
  const ws = new Workspace(fixture);
  try {
    assert.equal(await ws.definition({ file: "src/main.c", line: 14, symbol: "parse_config" }), "src/config.h:11:5  int parse_config(const char *text, struct settings *out);");
    const refs = (await ws.references({ file: "src/main.c", line: 14, symbol: "parse_config" })).split("\n");
    assert.deepEqual(refs.map((r) => r.split("  ")[0]), ["src/config.c:5:5", "src/config.c:19:12", "src/config.h:11:5", "src/main.c:14:13", "src/report.c:7:5"]);
    // Not the struct field of the same name, the comment, the error message or parse_config_file.
    const field = await ws.references({ file: "src/main.c", line: 19, symbol: "parse_config" });
    assert.ok(field.includes("src/config.h:16:11") && !field.includes("src/report.c"));
    assert.match(await ws.hover({ file: "src/report.c", line: 7, symbol: "parse_config" }), /Fills in settings/);
    assert.equal(await ws.diagnostics({ file: "src/report.c" }), "src/report.c:13:12  error  Use of undeclared identifier 'undefined_value'");
    assert.equal(await ws.diagnostics({ file: "src/config.c" }), "No problems.");
    assert.match(await ws.symbols({ file: "src/config.h" }), /function parse_config {2}11/);
  } finally {
    await ws.stop();
  }
  // Nothing was written into the project: no index, no cache.
  assert.deepEqual(readdirSync(fixture).sort(), ["compile_flags.txt", "src"]);
});

test("live: a file changed on disk is seen fresh", live, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "symbolhop-"));
  writeFileSync(path.join(root, "compile_flags.txt"), "-xc\n");
  const file = path.join(root, "a.c");
  writeFileSync(file, "int f(void) { return missing; }\n");
  const ws = new Workspace(root);
  try {
    assert.match(await ws.diagnostics({ file: "a.c" }), /undeclared/);
    writeFileSync(file, "int f(void) { return 0; }\n");
    assert.equal(await ws.diagnostics({ file: "a.c" }), "No problems.");
  } finally {
    await ws.stop();
    rmSync(root, { recursive: true });
  }
});

test("live: the MCP server over stdio, as an agent runs it", live, async () => {
  const child = spawn(process.execPath, ["src/cli.js", "serve", "--root", fixture], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const wait = async (id) => {
    for (let i = 0; i < 200; i++) {
      const hit = lines.find((l) => l.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("no reply");
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.equal((await wait(1)).result.serverInfo.name, "symbolhop");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lsp_references", arguments: { file: "src/report.c", line: 7, symbol: "parse_config" } } });
  const refs = await wait(2);
  assert.equal(refs.result.isError, false);
  assert.equal(refs.result.content[0].text.split("\n").length, 5);
  child.stdin.write("not json\n");
  await new Promise((r) => setTimeout(r, 200));
  child.stdin.end();
  await new Promise((resolve) => child.on("exit", resolve));
  assert.ok(lines.some((l) => l.error?.code === -32700));
});

test("the CLI prints usage and fails clearly", () => {
  assert.match(execFileSync(process.execPath, ["src/cli.js", "--help"], { encoding: "utf8" }), /symbolhop serve/);
  assert.throws(() => execFileSync(process.execPath, ["src/cli.js", "def", "../outside.c", "1", "x", "--root", fixture], { stdio: "pipe" }));
});

test("names that merely start with two dots are inside the project", () => {
  const root = mkdtempSync(path.join(tmpdir(), "symbolhop-"));
  writeFileSync(path.join(root, "..notes.c"), "int x;\n");
  assert.equal(path.basename(new Workspace(root).resolve("..notes.c")), "..notes.c");
  rmSync(root, { recursive: true });
});

test("network paths are refused without being touched", () => {
  const ws = new Workspace(fixture);
  for (const bad of ["//server/share/a.c", "\\\\server\\share\\a.c", "/etc/passwd", "/nonexistent/a.c"]) {
    assert.throws(() => ws.resolve(bad), /outside the project/, bad);
  }
});

test("lines end at CR, LF or CRLF, and are read again after an edit", () => {
  const root = mkdtempSync(path.join(tmpdir(), "symbolhop-"));
  const file = path.join(root, "cr.c");
  writeFileSync(file, "int a;\rint b;\r\nint c;\n");
  const ws = new Workspace(root);
  assert.equal(ws.lines(ws.resolve("cr.c")).length, 4);
  writeFileSync(file, "int a;\nint b;\nint c;\nint d;\nint e;\n");
  assert.deepEqual(ws.position(ws.resolve("cr.c"), { line: 5, symbol: "e" }), { line: 4, character: 4 });
  rmSync(root, { recursive: true });
});

test("languages whose servers run build files are off unless asked for", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "symbolhop-"));
  writeFileSync(path.join(root, "A.java"), "class A {}\n");
  await assert.rejects(new Workspace(root).symbols({ file: "A.java" }), /isn't turned on/);
  await assert.rejects(new Workspace(root, { languages: ["java"], env: { PATH: "/nonexistent" } }).symbols({ file: "A.java" }), /No java language server/);
  rmSync(root, { recursive: true });
});

test("the warm-up says when it couldn't show every file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "symbolhop-"));
  for (let i = 0; i < 5; i++) writeFileSync(path.join(root, `f${i}.c`), "");
  assert.deepEqual(projectFiles(root, "c", { maxFiles: 3, withCount: true }).complete, false);
  assert.deepEqual(projectFiles(root, "c", { maxFiles: 5, withCount: true }).complete, true);
  rmSync(root, { recursive: true });
});

test("MCP: notifications get no reply, client replies are ignored, junk doesn't crash it", async () => {
  const ws = new Workspace(fixture);
  assert.equal(await handle(ws, { jsonrpc: "2.0", method: "ping" }), null);
  assert.equal(await handle(ws, { jsonrpc: "2.0", method: "tools/list" }), null);
  assert.equal(await handle(ws, { jsonrpc: "2.0", id: 9, result: {} }), null);
  for (const junk of [null, 42, "x", [], {}]) assert.equal((await handle(ws, junk)).error.code, -32600);
  for (const tool of TOOLS) assert.equal(tool.annotations.readOnlyHint, true);
});

test("a language server that closes its input or prints junk fails one call, not symbolhop", async () => {
  for (const mode of ["closestdin", "junk"]) {
    const ws = new Workspace(fixture, { servers: { c: [[process.execPath, path.resolve("test/fake-server.mjs"), mode]] }, timeout: 2_000 });
    await assert.rejects(ws.definition({ file: "src/main.c", line: 14, symbol: "parse_config" }));
    await ws.stop();
  }
});

test("live: an edit anywhere in the project is seen by the next question", live, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "symbolhop-"));
  writeFileSync(path.join(root, "compile_flags.txt"), "-xc\n");
  writeFileSync(path.join(root, "a.h"), "int shared(void);\n");
  writeFileSync(path.join(root, "a.c"), '#include "a.h"\nint shared(void) { return 1; }\n');
  writeFileSync(path.join(root, "b.c"), '#include "a.h"\nint b(void) { return shared(); }\n');
  const ws = new Workspace(root);
  try {
    assert.equal((await ws.references({ file: "a.h", line: 1, symbol: "shared" })).split("\n").length, 3);
    // The agent adds lines to b.c and a new caller in a.c.
    writeFileSync(path.join(root, "b.c"), '#include "a.h"\n\n\nint b(void) { return shared(); }\n');
    writeFileSync(path.join(root, "a.c"), '#include "a.h"\nint shared(void) { return 1; }\nint again(void) { return shared(); }\n');
    const refs = await ws.references({ file: "b.c", line: 4, symbol: "shared" });
    assert.match(refs, /b\.c:4:/);
    assert.match(refs, /a\.c:3:/);
  } finally {
    await ws.stop();
    rmSync(root, { recursive: true });
  }
});

test("live: nothing is written anywhere in the project, at any depth", live, async () => {
  const list = (dir) => readdirSync(dir, { recursive: true }).sort();
  const before = list(fixture);
  const ws = new Workspace(fixture);
  await ws.references({ file: "src/config.h", line: 11, symbol: "parse_config" });
  await ws.diagnostics({ file: "src/report.c" });
  await ws.stop();
  assert.deepEqual(list(fixture), before);
});
