// The MCP side: JSON-RPC messages, one per line, over stdin and stdout, as the MCP stdio transport
// specifies. Tools only; no resources, prompts or sampling, and nothing is ever written to disk.
import { Workspace, ToolError } from "./tools.js";

export const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const position = {
  file: { type: "string", description: "Path of the file, relative to the project folder." },
  line: { type: "integer", minimum: 1, description: "1-based line number." },
  symbol: { type: "string", description: "The identifier on that line to ask about. Easier than a column." },
  column: { type: "integer", minimum: 1, description: "1-based column in UTF-16 code units, as LSP counts them, if no symbol is given." },
  occurrence: { type: "integer", minimum: 1, description: "Which match of the symbol on the line, when it appears more than once. Default 1." },
};

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: "lsp_definition",
    description: "Find where a symbol is defined, using the project's language server: exact, unlike text search. Returns path:line:col and the line.",
    inputSchema: { type: "object", properties: position, required: ["file", "line"], additionalProperties: false },
    annotations,
  },
  {
    name: "lsp_references",
    description: "Find every use of a symbol across the project, using the project's language server. Skips comments, strings and other symbols with the same name. Returns path:line:col and the line for each.",
    inputSchema: {
      type: "object",
      properties: { ...position, includeDeclaration: { type: "boolean", description: "Include the definition itself. Default true." }, limit: { type: "integer", minimum: 1, maximum: 1000 } },
      required: ["file", "line"],
      additionalProperties: false,
    },
    annotations,
  },
  {
    name: "lsp_hover",
    description: "The type, signature and documentation of a symbol, as the language server shows them.",
    inputSchema: { type: "object", properties: position, required: ["file", "line"], additionalProperties: false },
    annotations,
  },
  {
    name: "lsp_diagnostics",
    description: "Errors and warnings the language server reports for a file, as it is on disk now. Useful right after editing it.",
    inputSchema: { type: "object", properties: { file: position.file }, required: ["file"], additionalProperties: false },
    annotations,
  },
  {
    name: "lsp_symbols",
    description: "The outline of a file: its classes, functions, methods and so on, with line numbers.",
    inputSchema: { type: "object", properties: { file: position.file }, required: ["file"], additionalProperties: false },
    annotations,
  },
];

const handlers = {
  lsp_definition: (ws, a) => ws.definition(a),
  lsp_references: (ws, a) => ws.references(a),
  lsp_hover: (ws, a) => ws.hover(a),
  lsp_diagnostics: (ws, a) => ws.diagnostics(a),
  lsp_symbols: (ws, a) => ws.symbols(a),
};

/** Handles one request and returns its response, or null for a notification. */
export async function handle(workspace, message) {
  const id = message !== null && typeof message === "object" ? message.id : undefined;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const error = (code, text) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message: text } });
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") return error(-32600, "Not a JSON-RPC 2.0 request.");
  // A reply from the client (symbolhop never asks it anything) needs no answer.
  if (message.method === undefined && ("result" in message || "error" in message)) return null;
  if (typeof message.method !== "string") return error(-32600, "Not a JSON-RPC 2.0 request.");
  // Notifications are never answered, whatever they are.
  if (id === undefined) return null;
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      return reply({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "symbolhop", version: "0.1.0" },
        instructions: "Use lsp_definition and lsp_references instead of searching text when you need where a symbol is defined or used: they're exact and short. Give the file, the line, and the symbol's name on that line.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (!handlers[name]) return error(-32602, `Unknown tool: ${name}`);
      if (typeof args !== "object" || Array.isArray(args)) return error(-32602, "Arguments must be an object.");
      try {
        const text = await handlers[name](workspace, args);
        return reply({ content: [{ type: "text", text }], isError: false });
      } catch (e) {
        // Mistakes and missing servers go back to the agent as tool errors it can act on.
        const text = e instanceof ToolError ? e.message : `The language server failed: ${e.message}`;
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return error(-32601, `Unknown method: ${message.method}`);
  }
}

/** Runs the server on stdin and stdout until stdin closes. */
export function serve(root, { input = process.stdin, output = process.stdout, languages } = {}) {
  const workspace = new Workspace(root, languages ? { languages } : {});
  let buffer = "";
  const write = (response) => {
    if (response) output.write(JSON.stringify(response) + "\n");
  };
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024) buffer = "";
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Not JSON." } });
        continue;
      }
      handle(workspace, message)
        .then(write, (e) => write({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: String(e?.message ?? e) } }))
        .catch(() => {});
    }
  });
  input.on("end", () => workspace.stop().finally(() => process.exit(0)));
  return workspace;
}
