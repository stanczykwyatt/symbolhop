# Changelog

## 0.1.0 (2026-12-01)

First release.

- **An MCP server** with five read-only tools: `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_diagnostics` and `lsp_symbols`, for Codex, Claude Code, Gemini CLI, Cursor and any other MCP client.
- **The same answers from the command line:** `symbolhop def`, `refs`, `hover`, `diag`, `outline` and `doctor`.
- **Uses the language servers you have:** clangd, typescript-language-server, pyright, gopls, rust-analyzer, sourcekit-lsp and more, picked by each file's language, with `--languages` to choose.
- **Symbols by name:** give the file, the line and the name, not a column.
- **Always current:** files edited since the last question are sent to the server again first.
- **Only inside the project,** never writes anything itself, no network, no dependencies.
