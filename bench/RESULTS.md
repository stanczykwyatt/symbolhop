# Measurements

How much an agent reads when it looks for where a symbol is used: `grep`, the way agents usually do it, against symbolhop's `lsp_references`.

**How it's measured** ([bench/measure.mjs](measure.mjs), rerun with `node bench/measure.mjs`; CI reruns it and fails if the table changes):

- **The project is made up,** generated fresh in a temporary folder: a header and 25 C files shaped like real code. Each module calls a shared function, has local variables named like a struct field, uses a helper whose name starts the same as another function, and has a comment and a log message that mention functions by name. That mix is common in real code, but this project has more of it than most, so treat the ratios as an example, not an average.
- **The true uses are written down while the project is generated,** by file and line, and every tool, symbolhop included, is graded against that list. "Not a use" is a line that isn't one; "Uses missed" is a true use that's absent.
- **Tokens are estimated** as characters divided by 4, for exactly what each tool returns.
- **Not counted:** MCP's one-time cost of listing the tools, about 750 tokens per session, and time: the first question starts clangd, about a second, where grep is instant.
- **clangd** is the language server; grep is the system's.

Measured on a Mac with Apple clangd 17. In the README, the headline is the first question, the best case for symbolhop; the other two are smaller wins.

<!-- output -->
Made-up C project: 25 source files and a header, clangd 17.0.0.

| Looking for | With | Lines back | Not a use | Uses missed | ~Tokens |
|---|---|---:|---:|---:|---:|
| count_entries: a function (one of two with the same prefix) | `grep -rn` | 77 | 67 | 0 | 1587 |
| count_entries: a function (one of two with the same prefix) | `grep -rnw` | 59 | 49 | 0 | 1301 |
| count_entries: a function (one of two with the same prefix) | `lsp_references` | 10 | 0 | 0 | 141 |
| init: a short function name | `grep -rn` | 52 | 26 | 0 | 788 |
| init: a short function name | `grep -rnw` | 50 | 24 | 0 | 768 |
| init: a short function name | `lsp_references` | 26 | 0 | 0 | 187 |
| count: a struct field that shares its name with local variables | `grep -rn` | 201 | 128 | 0 | 2922 |
| count: a struct field that shares its name with local variables | `grep -rnw` | 148 | 75 | 0 | 1899 |
| count: a struct field that shares its name with local variables | `lsp_references` | 73 | 0 | 0 | 1064 |

Tokens, grep divided by lsp_references, per question: 9.2–11.3×, 4.1–4.2×, 1.8–2.7×.
