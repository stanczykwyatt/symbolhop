# Contributing

Thanks for helping out! Bug reports, ideas and pull requests are all welcome.

## Reporting a wrong or missing answer

Open a [bug report](https://github.com/stanczykwyatt/symbolhop/issues/new?template=bug.yml) with the language, the language server and its version (`clangd --version`, say), your agent, and what you asked. The most useful thing is a small made-up project that shows it, since the answers come from the language server and depend on the project's setup. Please don't share code you can't make public.

## Getting started

You need Node 20 or later. The live tests need `clangd` (with Xcode's tools on a Mac, or `apt install clangd`); without it they're skipped.

```bash
node --test test/*.test.js            # the tests
node bench/measure.mjs       # the grep-versus-references measurement
node src/cli.js doctor       # which language servers it finds
node src/cli.js refs src/main.c 14 parse_config --root test/fixtures/c-project
```

## How it's put together

- `src/lsp.js` is a small language server client: message framing, requests with time limits, opening files and keeping them in step with the disk, and collecting diagnostics.
- `src/tools.js` is the five tools: finding the symbol on a line, keeping every path inside the project, starting the right server, and turning answers into one short line each.
- `src/mcp.js` is the MCP server: JSON-RPC over stdio, one message per line.
- `src/cli.js` is the command line.

There are no dependencies, on purpose: everything that runs is in `src/`.

## Ground rules

- **Read-only.** No tool may ask for edits or apply them, and nothing may write a file.
- **Inside the project only.** Every path goes through `Workspace.resolve`.
- **No network, no shell, no dependencies.**
- **Short answers.** Agents pay for every token; keep output to a line per result.
- **Made-up code only** in fixtures and measurements.
- Run `node --test test/*.test.js` before opening a pull request, and add a test with your change.
- Keep commits small, with a short message saying what changed and why.

## Security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
