# Security

symbolhop is a tool a coding agent calls on its own, so it's built to be safe to hand over: it only reads, only inside your project, and never goes online.

## Reporting a vulnerability

Please report security problems privately through **Security → Report a vulnerability** on this repository, not in a public issue. You'll get a reply within a few days.

## What it does

- **Starts language servers** that are already on your PATH, chosen from a fixed list by the file's extension (`clangd`, `typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer`, `sourcekit-lsp` and a few others). They're started directly, never through a shell, with the project folder as their working folder, and stopped when symbolhop stops. Nothing an agent sends can change which program runs or its arguments.
- **Reads files in the project** to send them to the language server and to show the matching lines. A file must resolve, after following links, to inside the project folder; anything else is refused with a message saying so. Files over 8 MB aren't sent.
- **Asks five read-only questions:** definition, references, hover, diagnostics and document symbols. It never asks for renames, code actions, formatting or anything else that produces edits, and it applies none.
- **Talks over stdio only:** MCP messages with the agent on stdin and stdout, LSP messages with the language server on its stdin and stdout.

## What it doesn't do

- **Write anything itself.** No files, caches or logs, in your project or anywhere else. clangd is started with its background index off (it would write a `.cache` folder into the project), precompiled headers in memory instead of temporary files, and `.clangd` config files ignored; the tests check the whole project folder is unchanged afterwards. Other servers may keep caches of their own, below.
- **Use the network.** It has no networking code and no dependencies, only Node's built-in modules. CI checks for network modules and for shells.
- **List what's outside the project.** Locations in other places, like system headers or the standard library, are counted, not listed, and absolute paths outside the project are cut to their file name in diagnostics. A hover can still show the declaration and documentation of something defined outside the project, such as a system header the code includes, and that's by design: it's how you see `printf`'s signature.

## Limits worth knowing

- **Language servers can run code from the project.** They're programs you installed, running with your permissions, outside any sandbox your agent runs in. Some run code from the project they're pointed at: a TypeScript server may load the project's own copy of TypeScript, pyright may run the Python interpreter a project's config names, gopls may download modules, and Java, Ruby and Zig servers run the project's build files. So if an agent can write files in the project, asking a question can run what it wrote. symbolhop narrows this: Java, Ruby and Zig are off unless you name them with `--languages`, and rust-analyzer is started with build scripts and proc macros turned off. To be strict, run only the servers you trust for that project, for example `--languages c`.
- **Language servers may write caches of their own:** sourcekit-lsp can index into `.build`, rust-analyzer may build into `target`, and jdtls keeps workspace data. symbolhop doesn't, and clangd is set up not to.
- **The agent decides what to ask.** symbolhop limits answers to the project and to reading, but anything inside the project can be read and shown to the agent, as it already could with its own tools.
- **Output is capped** at 200 results per question by default (1,000 at most), with each line clipped, so a huge result can't flood the agent.

## Dependencies

None at run time. The tests use Node's built-in test runner.
