# Relatum

<p align="center">
  <strong>Local canvases, Markdown notes, and study tools.</strong>
</p>

<p align="center">
  An open-source, local-first knowledge canvas and study workspace for Windows<br>
  Built for visual notes, personal knowledge management, course work, research, and mind maps<br>
  Interface languages: Simplified Chinese · English
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="https://github.com/yamibk/Relatum/releases/latest/download/Relatum-release.zip"><strong>Download for Windows</strong></a> ·
  <a href="https://github.com/yamibk/Relatum/releases/latest">Latest release</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <a href="https://github.com/yamibk/Relatum/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/yamibk/Relatum?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111111?style=flat-square"></a>
  <img alt="Windows 10 and 11" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-2563eb?style=flat-square">
  <img alt="Local first" src="https://img.shields.io/badge/data-local--first-2f855a?style=flat-square">
</p>

<p align="center">
  <a href="https://github.com/yamibk/Relatum/releases/latest">
    <img src="docs/images/relatum-style-panel.png" alt="Relatum freeform canvas, connected knowledge, and style panel">
  </a>
</p>

## What is Relatum?

Relatum is an open-source Windows app with four workspaces: Canvas, Notes, Research, and Career.

No account is required. Notes, canvases, and settings stay on your computer. Core features work offline; the optional AI assistant connects to a service you configure.

## Highlights

### Canvas

- Add text, images, code, and attachments to an infinite canvas. Move and connect them freely.
- Customize nodes and connections, add handwriting, arrange mind maps with one click, and export PNG images.
- Basic compatibility with the Obsidian Canvas format.

### Notes

- Live Markdown rendering with math, code, Callouts, images, and embedded canvases.
- Organize files with notebooks, folders, and tabs. Edits save automatically.
- Find and browse notes using search, recent files, tags, outlines, wikilinks, and relationship graphs.

### Reading and reference material

- Read and annotate PDF and Markdown documents.
- Use math, Mermaid diagrams, and local attachments. Import Markdown folders.

### Study and Career

- Study tasks, daily tasks, Pomodoro timers, and stopwatches.
- Calendar, diary, countdowns, quick notes, and review cards.
- The Career workspace shows daily usage, yearly heatmaps, and workspace usage trends, with date-range filters.

### Appearance and AI

- Themes, custom backgrounds, templates, and style presets.
- An optional AI assistant for chat, organizing content, and generating canvases. Configure your own endpoint, model, and API key.

## Screenshots

### Notes: live Markdown rendering

See math, lists, and Callouts as you edit. Use the outline to jump to a section.

![Relatum Notes workspace with live Markdown rendering, math, a Callout, and an outline](docs/images/relatum-notes-live-preview.png)

### Notes: browsing and search

Find notes through recent files, tags, and search. The list shows titles, previews, and file paths.

![Relatum Notes workspace with recent files, tags, and search controls](docs/images/relatum-notes-browser.png)

### Career: usage statistics

View daily usage, a yearly heatmap, and workspace usage trends. Filter by all records, 30 days, 90 days, this year, or a custom range.

![Relatum Career workspace with daily usage, a yearly heatmap, and workspace usage trends](docs/images/relatum-career-usage.png)

### More screenshots

<table>
  <tr>
    <td width="50%">
      <img src="docs/images/relatum-goal-tree.png" alt="Independent goal trees and progressive tasks in Relatum">
      <p align="center">Goal trees and progressive tasks</p>
    </td>
    <td width="50%">
      <img src="docs/images/relatum-quick-notes.png" alt="Colorful quick notes and visual relationship lines in Relatum">
      <p align="center">Quick notes and visual relationships</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/images/relatum-activity.png" alt="Annual activity statistics and canvas constellation in Relatum">
      <p align="center">Annual activity and canvas constellation</p>
    </td>
    <td width="50%">
      <img src="docs/images/relatum-daily-tasks.png" alt="Daily tasks, streaks, and milestones in Relatum">
      <p align="center">Daily tasks, streaks, and milestones</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/images/relatum-knowledge-canvas.png" alt="Relatum freeform canvas with connected course knowledge">
      <p align="center">Freeform canvas and course knowledge map</p>
    </td>
    <td width="50%">
      <img src="docs/images/relatum-calendar.png" alt="Relatum calendar, diary, countdowns, and daily records">
      <p align="center">Calendar, diary, countdowns, and daily records</p>
    </td>
  </tr>
</table>

## Quick start

### Download the Windows app

1. [Download the latest `Relatum-release.zip`](https://github.com/yamibk/Relatum/releases/latest/download/Relatum-release.zip).
2. Fully extract the ZIP into a writable folder.
3. Run `Relatum.exe`.

Relatum supports Windows 10/11 and requires Microsoft Edge WebView2 Runtime, which is normally included with modern Windows installations.

> Do not overwrite an old installation in place. Keep the old `data/`, `canvases/`, and `notes/` folders until you have confirmed that the new version works, then migrate your personal data.

### Run from source

Source mode requires Windows 10/11 and Python 3.9 or later. The runtime path uses only the Python standard library:

```powershell
python app.py
```

You can also double-click `打开画布.bat`, or run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

On first launch, Relatum creates:

- `canvases/` for `.canvas` files and their attachments.
- `notes/` for Notes-workspace `.md` files, nested folders, and local images.
- `data/` for recent items, study records, calendar data, window state, and AI configuration.

All three directories are excluded by `.gitignore` and are not part of the source repository. See the [privacy documentation](docs/PRIVACY.md) for the complete data boundary.

## Build the Windows desktop app

Desktop builds support Python 3.9–3.12. The build script creates a temporary environment and installs pinned versions of PyWebView, PyInstaller, and Pillow:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-desktop.ps1
```

The output is placed in the sibling `Relatum-release/` directory. User `data/`, `canvases/`, and `notes/` are never bundled into the release.

### Build the Microsoft Store package

Install the Windows 10/11 SDK (including `MakeAppx.exe`), then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-msix.ps1
```

The output is placed in the sibling `Relatum-store/` directory. Upload
`Relatum_<version>_x64.msixupload` to Partner Center. Store installations keep
canvas and settings data under `%LOCALAPPDATA%\Relatum`; source mode and the
GitHub portable build retain their existing data locations.

## Project structure

```text
Relatum/
├─ app.py                    Local HTTP service and data API
├─ notes_library.py          Markdown library, wikilink index, and path-safety layer
├─ desktop.py                Windows desktop shell
├─ assets/                   HTML, CSS, JavaScript, and runtime assets
├─ packaging/                Icon, font, and desktop build helpers
├─ build-desktop.ps1         Windows portable release build entry point
├─ build-msix.ps1            Microsoft Store MSIX build entry point
├─ start.ps1                 Source-mode launcher
├─ AI笔记创作指南.md          External canvas/Markdown authoring reference (not a runtime dependency)
└─ AGENTS.md                 Architecture and maintenance constraints
```

## Development and checks

Relatum has no npm build step. Before submitting a change, run at least:

```powershell
python -m py_compile app.py desktop.py packaging\make_icon.py packaging\make_font_subset.py

Get-ChildItem assets -Recurse -Filter *.js |
  Where-Object { $_.FullName -notmatch '\\vendor\\' } |
  ForEach-Object { node --check $_.FullName }

powershell -ExecutionPolicy Bypass -File .\scripts\check-public.ps1
```

Before creating a public ZIP or formal release, also run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-public.ps1 -Physical
```

## Contributing

Bug reports, feature ideas, documentation improvements, and code contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before starting.

## Third-party components and license

Mermaid, MathJax, PDF.js, and several fonts are bundled for offline use. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licensing and attribution.

Original Relatum source code and documentation are available under the [MIT License](LICENSE), Copyright © 2026 yamibk. Third-party components, fonts, and media assets remain subject to their respective licenses.
