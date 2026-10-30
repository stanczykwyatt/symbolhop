// A small language server client: JSON-RPC with Content-Length framing over a child process's
// stdio. Only what symbolhop asks for: start, open files and keep them in step with the disk, a few
// read-only requests, and diagnostics.
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const MAX_HEADER = 8 * 1024;
const MAX_BODY = 64 * 1024 * 1024;

/** Splits a byte stream into LSP messages. Exported for tests. */
export class Framer {
  constructor(onMessage) {
    this.chunks = [];
    this.size = 0;
    this.onMessage = onMessage;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    for (;;) {
      const buffer = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
      this.chunks = [buffer];
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        // A header never runs this long: whatever is talking isn't a language server.
        if (buffer.length > MAX_HEADER) throw new Error("A language server wrote something that isn't LSP to its output.");
        return;
      }
      const header = buffer.subarray(0, end).toString("ascii");
      const match = /Content-Length: *(\d+)/i.exec(header);
      if (!match) {
        this.drop(end + 4);
        continue;
      }
      const length = Number(match[1]);
      if (length > MAX_BODY) throw new Error("A language server sent a message over 64 MB.");
      if (buffer.length < end + 4 + length) return;
      const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
      this.drop(end + 4 + length);
      try {
        this.onMessage(JSON.parse(body));
      } catch {
        // A malformed message is skipped.
      }
    }
  }

  drop(count) {
    const rest = this.chunks[0].subarray(count);
    this.chunks = [rest];
    this.size = rest.length;
  }
}

export function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export const toUri = (file) => pathToFileURL(file).href;
/** A local path for a file: URI, or null for anything else (jdt:, untitled:, …). */
export const fromUri = (uri) => {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
};

/** The language id for a file, and which server family handles it. */
export function languageOf(file) {
  const ext = path.extname(file).toLowerCase();
  const table = {
    ".ts": ["typescript", "typescript"], ".tsx": ["typescriptreact", "typescript"], ".js": ["javascript", "typescript"],
    ".jsx": ["javascriptreact", "typescript"], ".mjs": ["javascript", "typescript"], ".cjs": ["javascript", "typescript"],
    ".py": ["python", "python"], ".go": ["go", "go"], ".rs": ["rust", "rust"],
    ".c": ["c", "c"], ".h": ["c", "c"], ".cc": ["cpp", "c"], ".cpp": ["cpp", "c"], ".cxx": ["cpp", "c"], ".hpp": ["cpp", "c"],
    ".m": ["objective-c", "c"], ".mm": ["objective-cpp", "c"], ".swift": ["swift", "swift"],
    ".java": ["java", "java"], ".rb": ["ruby", "ruby"], ".lua": ["lua", "lua"], ".zig": ["zig", "zig"],
  };
  const hit = table[ext];
  return hit ? { languageId: hit[0], family: hit[1] } : null;
}

export class LanguageServer {
  /**
   * @param {string[]} command the server and its arguments, started without a shell
   * @param {string} root the project folder
   */
  constructor(command, root, { timeout = 15_000, settings = null } = {}) {
    this.command = command;
    this.root = root;
    this.timeout = timeout;
    this.settings = settings;
    this.nextId = 1;
    this.pending = new Map();
    this.opened = new Map();
    this.diagnostics = new Map();
    this.waiters = [];
    this.ready = null;
    /** Set once the project's files have been shown to it, for servers that need that. */
    this.warmed = false;
  }

  start() {
    if (this.ready) return this.ready;
    this.child = spawn(this.command[0], this.command.slice(1), {
      cwd: this.root,
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      env: { ...process.env },
    });
    const framer = new Framer((message) => this.receive(message));
    this.child.stdout.on("data", (chunk) => {
      try {
        framer.push(chunk);
      } catch (error) {
        this.fail(error);
        this.child.kill("SIGKILL");
      }
    });
    // A server that closes its input or dies mid-write must not take symbolhop down with it.
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) => this.fail(new Error(`${path.basename(this.command[0])} stopped (exit ${code}).`)));
    this.ready = this.request("initialize", {
      processId: process.pid,
      rootUri: toUri(this.root),
      workspaceFolders: [{ uri: toUri(this.root), name: path.basename(this.root) }],
      initializationOptions: this.settings ?? undefined,
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          synchronization: { didSave: false },
          definition: { linkSupport: false },
          references: {},
          hover: { contentFormat: ["plaintext", "markdown"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: false, versionSupport: true },
        },
        workspace: { symbol: {}, workspaceFolders: true, configuration: true },
      },
      clientInfo: { name: "symbolhop", version: "0.1.0" },
    }).then((result) => {
      this.capabilities = result?.capabilities ?? {};
      this.notify("initialized", {});
      return this;
    });
    return this.ready;
  }

  get dead() {
    return this.failure ?? null;
  }

  fail(error) {
    this.failure ??= error;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters = [];
  }

  receive(message) {
    if (message.id !== undefined && message.method === undefined) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.pending.delete(message.id);
      if (message.error) waiting.reject(Object.assign(new Error(message.error.message ?? "The language server returned an error."), { code: message.error.code }));
      else waiting.resolve(message.result ?? null);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics" && message.params?.uri) {
      const { uri, version, diagnostics } = message.params;
      // Diagnostics for an older version of the file than the one it was last sent are stale.
      const current = this.opened.get(uri)?.version;
      if (Number.isInteger(version) && current !== undefined && version < current) return;
      this.diagnostics.set(uri, diagnostics ?? []);
      for (const waiter of this.waiters.filter((w) => w.uri === uri)) waiter.resolve();
      this.waiters = this.waiters.filter((w) => w.uri !== uri);
      return;
    }
    // Requests from the server: answer the ones that need an answer.
    if (message.id !== undefined && message.method) {
      let result = null;
      if (message.method === "workspace/configuration") result = (message.params?.items ?? []).map(() => this.settings ?? null);
      if (message.method === "workspace/workspaceFolders") result = [{ uri: toUri(this.root), name: path.basename(this.root) }];
      try {
        this.send({ jsonrpc: "2.0", id: message.id, result });
      } catch {
        // Gone already.
      }
    }
  }

  send(message) {
    if (this.dead) throw this.dead;
    this.child.stdin.write(frame(message));
  }

  notify(method, params) {
    this.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  request(method, params) {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${path.basename(this.command[0])} didn't answer ${method} within ${this.timeout / 1000} s.`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Opens a file with the server, or sends its new text if it changed on disk since. */
  open(file) {
    const uri = toUri(file);
    const stat = statSync(file);
    const known = this.opened.get(uri);
    if (known && known.mtime === stat.mtimeMs && known.size === stat.size) return uri;
    const text = readFileSync(file, "utf8");
    if (!known) {
      this.opened.set(uri, { file, version: 1, text, mtime: stat.mtimeMs, size: stat.size });
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageOf(file)?.languageId ?? "plaintext", version: 1, text } });
    } else if (known.text !== text) {
      known.version += 1;
      Object.assign(known, { text, mtime: stat.mtimeMs, size: stat.size });
      this.diagnostics.delete(uri);
      this.notify("textDocument/didChange", { textDocument: { uri, version: known.version }, contentChanges: [{ text }] });
    } else {
      Object.assign(known, { mtime: stat.mtimeMs, size: stat.size });
    }
    return uri;
  }

  /**
   * Brings every open file up to date with the disk, so an answer never comes from text the agent has
   * since changed: an open file overrides what's on disk for the server. Deleted files are closed.
   */
  sync() {
    const changed = [];
    for (const [uri, known] of this.opened) {
      try {
        const version = known.version;
        this.open(known.file);
        if (known.version !== version) changed.push(uri);
      } catch {
        this.opened.delete(uri);
        this.diagnostics.delete(uri);
        this.notify("textDocument/didClose", { textDocument: { uri } });
      }
    }
    return changed;
  }

  /** Diagnostics for a file, waiting up to `wait` ms for the server to publish them. */
  async diagnosticsFor(file, wait = 4_000) {
    const uri = this.open(file);
    if (!this.diagnostics.has(uri)) await this.published(uri, wait);
    return this.diagnostics.get(uri) ?? null;
  }

  /** Waits until the server publishes diagnostics for `uri`, or `wait` ms pass. */
  published(uri, wait) {
    if (this.diagnostics.has(uri) || this.dead) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { uri, resolve: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve();
      }, wait);
      this.waiters.push(waiter);
    });
  }

  async stop() {
    if (!this.child) return;
    if (!this.dead) {
      try {
        await Promise.race([this.request("shutdown"), new Promise((r) => setTimeout(r, 1_000))]);
        this.notify("exit");
      } catch {
        // Already gone.
      }
    }
    // A server that doesn't stop when asked is made to.
    const exited = new Promise((resolve) => (this.child.exitCode !== null || this.child.signalCode !== null ? resolve() : this.child.once("exit", resolve)));
    this.child.kill("SIGTERM");
    const stopped = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 1_500))]);
    if (!stopped) this.child.kill("SIGKILL");
  }
}
