# Relatum CodeMirror / Mermaid vendor notices

These browser assets are checked-in, offline runtime artifacts. Relatum never
loads them from a CDN. `dependency-lock.json` records the complete resolved
dependency graph and registry integrity values used for this vendor snapshot.

## Snapshot

- `relatum-codemirror.min.js`
  - SHA-256: `BB10BD37DDB94075A57C688C538219BAA75882E98925FF7BF4CF63A71155670E`
  - Direct packages: `@codemirror/state@6.7.1`, `@codemirror/view@6.43.9`,
    `@codemirror/language@6.12.4`, `@codemirror/lang-markdown@6.5.2`,
    `@codemirror/lang-cpp@6.0.3`, `@codemirror/lang-python@6.2.1`,
    `@codemirror/lang-javascript@6.2.5`, `@codemirror/lang-json@6.0.2`,
    `@codemirror/lang-html@6.4.12`, `@codemirror/lang-css@6.3.1`,
    `@codemirror/lang-java@6.0.2`, `@codemirror/legacy-modes@6.5.3`,
    `@codemirror/commands@6.11.0`, `@codemirror/search@6.7.1`,
    `@codemirror/autocomplete@6.20.3`,
    `@lezer/markdown@1.7.2`, `@lezer/common@1.5.2`,
    `@lezer/highlight@1.2.3`.
- `../mermaid/mermaid.min.js`
  - Version: `11.17.1`
  - SHA-256: `B7A4CDA9E88E187D4E1F279B8A14A3DF651EDD8DC704B9B56ED8E84659735570`

## Local CodeMirror selection patch

The resolved package versions and dependency graph are unchanged. The bundled
selection renderer samples `.cm-line:not(.note-live-callout-line)` instead of
the first `.cm-line` for its shared horizontal fill boundaries. Callout padding
belongs to the card and must not inset selections in the ordinary text below it.
When only Callout lines are mounted, the existing no-sample fallback uses the
content bounds. Source lines, caret coordinates, selection ranges and copying
keep their existing behavior. Preserve this one selector change when rebuilding
the offline artifact. `node tests/note-callout-selection-regression.js` exercises
the actual bundled renderer with measured-coordinate fixtures without a browser.

## Rebuilding the note language snapshot

`relatum-entry.js` is the readable browser entry. `note-languages.js` contains
Relatum's local Structured Text/SCL and SPICE lexers. Verilog/SystemVerilog and
VHDL reuse the already pinned `@codemirror/legacy-modes@6.5.3` modes under the MIT
license below. The shared note style and exact language lookup are exported for
both editing and reading; reading uses Lezer's public `highlightTree` API.
The shared style also maps the existing Lezer `escape` tag, so string escape
sequences use the same explicit syntax class in live, source and reading views.

Run `node scripts/build-note-codemirror.js` from the repository to regenerate
the asset. This maintenance tool verifies archive integrity from the existing
lock and runs the pinned `esbuild@0.25.9` in a new system temporary directory.
It does not install npm, run package hooks, or add a project `node_modules`.
The selection patch above is reapplied with an exact source-match assertion.
Update the SHA-256 here after a successful build. Runtime and desktop packaging
continue to use only the checked-in offline browser asset.

## CodeMirror and Lezer

MIT License

Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Mermaid

The MIT License (MIT)

Copyright (c) 2014 - 2022 Knut Sveidqvist

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
