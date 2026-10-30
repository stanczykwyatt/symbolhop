// The tools an agent gets: definition, references, hover, diagnostics and symbols, answered by the
// project's own language servers. Read-only: nothing here edits a file.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { LanguageServer, languageOf, fromUri } from "./lsp.js";

/**
 * Servers tried for each language family, first one found on PATH wins. Each runs without a shell.
 * clangd keeps its index and precompiled headers in memory and ignores `.clangd` files, so it never
 * writes and can't be pointed elsewhere by a file in the project.
 */
export const SERVERS = {
  typescript: [["typescript-language-server", "--stdio"], ["vtsls", "--stdio"]],
  python: [["pyright-langserver", "--stdio"], ["basedpyright-langserver", "--stdio"], ["pylsp"]],
  go: [["gopls"]],
  rust: [["rust-analyzer"]],
  c: [["clangd", "--background-index=false", "--pch-storage=memory", "--enable-config=false", "--log=error"]],
  swift: [["sourcekit-lsp"]],
  java: [["jdtls"]],
  ruby: [["ruby-lsp"]],
  lua: [["lua-language-server"]],
  zig: [["zls"]],
};

/** Settings sent to servers that would otherwise run code from the project on their own. */
export const SETTINGS = {
  rust: { cargo: { buildScripts: { enable: false } }, procMacro: { enable: false } },
};

/**
 * Languages on unless chosen otherwise. Java, Ruby and Zig servers run the project's build files
 * (Gradle, Bundler, build.zig) as soon as they start, so they're only used when asked for with --languages.
 */
export const DEFAULT_LANGUAGES = ["c", "typescript", "python", "go", "rust", "swift", "lua"];

/** The first executable named `name` on PATH, or null. */
export function which(name, env = process.env) {
  if (path.isAbsolute(name)) {
    try {
      return statSync(name).isFile() ? name : null;
    } catch {
      return null;
    }
  }
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

/**
 * Where an identifier sits on a line, 0-based. With `occurrence`, the nth match (1-based). Matches
 * whole words only, so `get` doesn't match `getAll`.
 */
export function columnOf(lineText, symbol, occurrence = 1) {
  if (!symbol) return null;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, "gu");
  let match;
  let seen = 0;
  while ((match = re.exec(lineText))) {
    seen += 1;
    if (seen === occurrence) return utf16Column(lineText, match.index);
  }
  return null;
}

// LSP positions count UTF-16 code units by default, which is what JavaScript strings index by.
const utf16Column = (_line, index) => index;

/** One line of output per location: `path:line:col  text`, with the project folder left off. */
export function formatLocation(root, file, range, lines) {
  const relative = path.relative(root, file) || path.basename(file);
  const line = range.start.line;
  const text = lines?.[line]?.trim() ?? "";
  return `${relative}:${line + 1}:${range.start.character + 1}${text ? "  " + clip(text, 160) : ""}`;
}

const clip = (text, length) => (text.length > length ? text.slice(0, length - 1) + "…" : text);

const SEVERITY = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

export class Workspace {
  /**
   * @param {string} root the project folder; every file asked about must be inside it
   * @param {{ env?: object, servers?: object, timeout?: number }} options
   */
  constructor(root, { env = process.env, servers = SERVERS, timeout, languages = DEFAULT_LANGUAGES } = {}) {
    this.root = realpathSync.native(path.resolve(root));
    this.env = env;
    this.servers = servers;
    this.languages = new Set(languages);
    this.timeout = timeout;
    this.running = new Map();
    this.lineCache = new Map();
  }

  /** A file inside the project, resolved through links, or an error saying why not. */
  resolve(file) {
    if (typeof file !== "string" || file.length === 0 || file.includes("\0")) throw new ToolError("Give a file path inside the project.");
    // Checked by its text before anything is looked up, so nothing outside is even probed for
    // existence, and a network path never reaches the filesystem.
    if (/^[\\/]{2}/.test(file)) throw new ToolError(`${file} is outside the project, so it's not read.`);
    const absolute = path.resolve(this.root, file);
    if (!this.inside(absolute)) throw new ToolError(`${file} is outside the project, so it's not read.`);
    if (!existsSync(absolute)) throw new ToolError(`No such file: ${file}`);
    const real = realpathSync.native(absolute);
    if (!this.inside(real)) throw new ToolError(`${file} is outside the project, so it's not read.`);
    if (!statSync(real).isFile()) throw new ToolError(`${file} isn't a file.`);
    if (statSync(real).size > 8 * 1024 * 1024) throw new ToolError(`${file} is over 8 MB, so it's not sent to a language server.`);
    return real;
  }

  /** Whether a path is the project folder or inside it, by its text. */
  inside(file) {
    const relative = path.relative(this.root, file);
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
  }

  /** A file's lines, read again whenever it changes on disk. */
  lines(file) {
    const stat = statSync(file);
    const cached = this.lineCache.get(file);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.lines;
    if (stat.size > 8 * 1024 * 1024) return [];
    const lines = readFileSync(file, "utf8").split(/\r\n|\r|\n/);
    if (this.lineCache.size > 256) this.lineCache.clear();
    this.lineCache.set(file, { lines, mtime: stat.mtimeMs, size: stat.size });
    return lines;
  }

  /** The running server for a file's language, started on first use. */
  async serverFor(file) {
    const language = languageOf(file);
    if (!language) throw new ToolError(`No language server is known for ${path.extname(file) || "files without an extension"}.`);
    if (!this.languages.has(language.family)) {
      throw new ToolError(`${language.family} isn't turned on. Its language server runs the project's build files, so it's only used when started with --languages ${language.family}.`);
    }
    let server = this.running.get(language.family);
    if (!server || server.dead) {
      if (server) await server.stop();
      const candidates = this.servers[language.family] ?? [];
      const found = candidates.map((command) => [which(command[0], this.env), command]).find(([full]) => full);
      if (!found) {
        throw new ToolError(`No ${language.family} language server found on PATH. Install one of: ${candidates.map((c) => c[0]).join(", ")}.`);
      }
      server = new LanguageServer([found[0], ...found[1].slice(1)], this.root, { timeout: this.timeout, settings: SETTINGS[language.family] });
      this.running.set(language.family, server);
    }
    await server.start();
    // Whatever the agent edited since the last question is sent first, so no answer is stale, and
    // the server is given a moment (5 s at most) to read the changes before it's asked.
    const deadline = Date.now() + 5_000;
    for (const uri of server.sync()) await server.published(uri, Math.max(0, deadline - Date.now()));
    return server;
  }

  /** Turns a tool's position arguments into an LSP position. Lines and columns given to tools are 1-based. */
  position(file, { line, column, symbol, occurrence }) {
    const lines = this.lines(file);
    if (lines.length === 0) throw new ToolError(`${path.relative(this.root, file)} is too big to read.`);
    if (!Number.isInteger(line) || line < 1 || line > lines.length) throw new ToolError(`Line ${line} isn't in ${path.relative(this.root, file)} (it has ${lines.length}).`);
    const text = lines[line - 1];
    if (symbol !== undefined) {
      const at = columnOf(text, String(symbol), occurrence ?? 1);
      if (at === null) throw new ToolError(`"${symbol}" isn't on line ${line}: ${clip(text.trim(), 120)}`);
      return { line: line - 1, character: at };
    }
    if (!Number.isInteger(column) || column < 1 || column > text.length + 1) throw new ToolError(`Give a symbol name, or a column from 1 to ${text.length + 1}.`);
    return { line: line - 1, character: column - 1 };
  }

  async locate(method, args, extra = {}) {
    const file = this.resolve(args.file);
    const position = this.position(file, args);
    const server = await this.serverFor(file);
    const uri = server.open(file);
    const result = await server.request(method, { textDocument: { uri }, position, ...extra });
    const items = (Array.isArray(result) ? result : result ? [result] : [])
      .map((item) => ({ uri: item.targetUri ?? item.uri, range: item.targetSelectionRange ?? item.range }))
      .filter((item) => item.uri && item.range);
    return this.list(items, args.limit);
  }

  /** Locations inside the project, one per line, sorted and without duplicates. Outside ones are counted, not shown. */
  list(items, limit = 200) {
    const shown = new Set();
    let outside = 0;
    for (const { uri, range } of items) {
      // Only files on disk inside the project, checked again after following links.
      let file = fromUri(uri);
      try {
        file = file && this.inside(file) ? realpathSync.native(file) : null;
      } catch {
        file = null;
      }
      if (!file || !this.inside(file)) {
        outside += 1;
        continue;
      }
      let lines = null;
      try {
        lines = this.lines(file);
      } catch {
        // A file the server knows about but can't be read here: show the location alone.
      }
      shown.add(formatLocation(this.root, file, range, lines));
    }
    const sorted = [...shown].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const cap = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 1000)) : 200;
    const out = sorted.slice(0, cap);
    if (sorted.length > cap) out.push(`… and ${sorted.length - cap} more`);
    if (outside) out.push(`(${outside} more outside the project, like the standard library)`);
    if (this.warmNote) out.push(this.warmNote);
    return out.length ? out.join("\n") : "No results.";
  }

  definition(args) {
    return this.locate("textDocument/definition", args);
  }

  async references(args) {
    await this.warm(args.file);
    return await this.locate("textDocument/references", args, { context: { includeDeclaration: args.includeDeclaration !== false } });
  }

  /**
   * Some servers (clangd without its background index, sourcekit-lsp) only know the files they've been
   * shown. Their index would be written into the project, so instead the project's files in that
   * language are opened once, up to a limit, and nothing is ever written.
   */
  async warm(file) {
    const real = this.resolve(file);
    const language = languageOf(real);
    if (!language || !WARMED.has(language.family)) return;
    const server = await this.serverFor(real);
    // Per server, so one that's restarted after a crash is shown the files again.
    if (server.warmed) return;
    server.warmed = true;
    const { files, complete } = projectFiles(this.root, language.family, { withCount: true });
    const uris = files.map((found) => server.open(found));
    // The server has read a file once it reports on it. Waits for all of them, up to 20 s together.
    const deadline = Date.now() + 20_000;
    for (const uri of uris) await server.published(uri, Math.max(0, deadline - Date.now()));
    this.warmNote = complete ? null : `(Only the first ${files.length} ${language.family} files were indexed, so uses in others may be missing.)`;
  }

  async hover(args) {
    const file = this.resolve(args.file);
    const position = this.position(file, args);
    const server = await this.serverFor(file);
    const uri = server.open(file);
    const result = await server.request("textDocument/hover", { textDocument: { uri }, position });
    const contents = result?.contents;
    const text = typeof contents === "string" ? contents
      : Array.isArray(contents) ? contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n")
      : contents?.value ?? "";
    return text.trim() ? clip(text.trim(), 4_000) : "No information.";
  }

  async diagnostics(args) {
    const file = this.resolve(args.file);
    const server = await this.serverFor(file);
    const found = await server.diagnosticsFor(file, 4_000);
    if (found === null) return "The language server hasn't reported on this file yet. Try again in a moment.";
    if (found.length === 0) return "No problems.";
    const relative = path.relative(this.root, file);
    return found
      .slice()
      .sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line)
      .map((d) => `${relative}:${d.range.start.line + 1}:${d.range.start.character + 1}  ${SEVERITY[d.severity ?? 1]}  ${clip(this.withoutOutsidePaths(String(d.message)).replace(/\s+/g, " "), 300)}`)
      .join("\n");
  }

  /** Absolute paths outside the project, in a message, cut to their file name. */
  withoutOutsidePaths(text) {
    return text.replace(/(?:[A-Za-z]:)?[\\/][^\s:'"()]+/g, (found) => (found.length > 1 && !this.inside(found) ? path.basename(found) : found));
  }

  /** The outline of a file: each symbol with its kind and line. */
  async symbols(args) {
    const file = this.resolve(args.file);
    const server = await this.serverFor(file);
    const uri = server.open(file);
    const result = (await server.request("textDocument/documentSymbol", { textDocument: { uri } })) ?? [];
    const out = [];
    const walk = (items, depth) => {
      for (const item of items) {
        const range = item.selectionRange ?? item.range ?? item.location?.range;
        out.push(`${"  ".repeat(depth)}${KINDS[item.kind] ?? "symbol"} ${item.name}  ${range ? range.start.line + 1 : "?"}`);
        if (item.children) walk(item.children, depth + 1);
      }
    };
    walk(result, 0);
    if (out.length > 500) return out.slice(0, 500).join("\n") + `\n… and ${out.length - 500} more`;
    return out.length ? out.join("\n") : "No symbols.";
  }

  async stop() {
    await Promise.all([...this.running.values()].map((server) => server.stop()));
    this.running.clear();
  }
}

const WARMED = new Set(["c", "swift"]);
const SKIPPED = new Set(["node_modules", "build", "dist", "out", "target", "vendor", "DerivedData", "Pods", "third_party"]);

/** Files of one language family in the project, skipping hidden, dependency and build folders. */
export function projectFiles(root, family, { maxFiles = 300, maxBytes = 20 * 1024 * 1024, withCount = false } = {}) {
  const found = [];
  let bytes = 0;
  let complete = true;
  const walk = (dir, depth) => {
    if (depth > 12 || found.length >= maxFiles) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (found.length >= maxFiles) {
        if (entry.isFile() && languageOf(entry.name)?.family === family) complete = false;
        if (entry.isDirectory()) complete = false;
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile() && languageOf(full)?.family === family) {
        const size = statSync(full).size;
        if (bytes + size > maxBytes) {
          complete = false;
          return;
        }
        bytes += size;
        found.push(full);
      }
    }
  };
  walk(root, 0);
  return withCount ? { files: found, complete } : found;
}

const KINDS = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method", 7: "property", 8: "field", 9: "constructor",
  10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number", 17: "boolean",
  18: "array", 19: "object", 20: "key", 21: "null", 22: "enum member", 23: "struct", 24: "event", 25: "operator", 26: "type parameter",
};

/** A mistake in what the agent asked, reported back to it as a tool error rather than a crash. */
export class ToolError extends Error {}
