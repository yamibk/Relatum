# Relatum

<p align="center">
  <strong>Put scattered thoughts on a freeform canvas, then shape them into knowledge you can use.</strong>
</p>

<p align="center">
  An open-source, local-first knowledge canvas and study workspace for Windows<br>
  Built for visual notes, personal knowledge management, course work, research, and mind maps<br>
  Interface languages: Simplified Chinese · English
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="https://github.com/yamibk/Relatum-Opensource/releases/latest/download/Relatum-release.zip"><strong>Download for Windows</strong></a> ·
  <a href="https://github.com/yamibk/Relatum-Opensource/releases/latest">Latest release</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <a href="https://github.com/yamibk/Relatum-Opensource/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/yamibk/Relatum-Opensource?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111111?style=flat-square"></a>
  <img alt="Windows 10 and 11" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-2563eb?style=flat-square">
  <img alt="Local first" src="https://img.shields.io/badge/data-local--first-2f855a?style=flat-square">
</p>

<p align="center">
  <a href="https://github.com/yamibk/Relatum-Opensource/releases/latest">
    <img src="https://github.com/user-attachments/assets/fed0dc96-c635-4e79-99c4-fef8f8eb8195" alt="Relatum freeform canvas with connected notes and mind maps">
  </a>
</p>

## What is Relatum?

Relatum is an open-source, local-first freeform knowledge canvas and study workspace. Create and connect ideas on an infinite canvas, organize course notes and research material, or turn an existing structure into a polished mind map with one click.

No account is required. Canvases, preferences, and optional AI credentials stay on your computer by default. Relatum is designed for Windows users looking for a visual note-taking app, a personal knowledge management (PKM) workspace, or an Obsidian Canvas-compatible workflow with extensive customization.

## Highlights

### A truly customizable freeform canvas

- Create, move, and connect nodes anywhere on an infinite canvas.
- Customize colors, size, shape, corner radius, opacity, font weight, text scale, and alignment.
- Style connections with different colors, paths, and line types; add handwriting, text boxes, color blocks, and decorative shapes.
- Basic compatibility with the Obsidian Canvas `nodes + edges` structure.

### One-click mind map layout

- Turn selected nodes or an entire connected structure into a mind map.
- Choose from multiple node, color, and connection presets.
- Adjust branch colors, hierarchy sizes, spacing, layout direction, and line styles.
- Keep editing after layout: move nodes, restyle them, and reorganize branches freely.

### Notes, documents, and visual research

- Markdown, math, Mermaid diagrams, code, images, PDF files, and Markdown attachments.
- Long-form reading, PDF/Markdown annotations, canvas search, minimap, and relationship graph.
- Import Markdown folders and export canvas content or PNG images.

### A study workspace beyond note-taking

- Pomodoro and stopwatch focus modes linked to study or daily tasks.
- Daily tasks, study boards, calendar and diary, countdowns, quick notes, and spaced review.
- A standalone review-card library with scheduled due reviews, unlimited shuffled free review, and an on-demand organization mode, independent of canvas nodes.
- Activity statistics, yearly progress, and task archives.

### Personalization, templates, and optional AI

- Soft gradients, immersive presets, and custom image backgrounds.
- Reusable custom templates and preset decorative shapes.
- Optional AI assistant for conversation, organizing content, and generating confirmed results onto the canvas.
- AI endpoint, model, and API key are configured by the user; the key is stored locally.

## Screenshots

<table>
  <tr>
    <td width="50%">
      <img src="docs/images/relatum-freeform-canvas.png" alt="Custom nodes, connections, and shapes on the Relatum freeform canvas">
      <p align="center">Freeform nodes, connections, and styles</p>
    </td>
    <td width="50%">
      <img src="docs/images/relatum-mind-map.png" alt="Relatum mind map presets and automatic layout">
      <p align="center">Mind map presets and one-click layout</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/images/relatum-focus-timer.png" alt="Relatum Pomodoro focus timer">
      <p align="center">Pomodoro and focus records</p>
    </td>
    <td width="50%">
      <img src="docs/images/relatum-activity-stats.png" alt="Relatum yearly activity and study statistics">
      <p align="center">Yearly activity and study statistics</p>
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/relatum-calendar-diary.png" alt="Relatum calendar, diary, countdowns, study plans, and focus records">
  <br>
  <em>Calendar, daily journal, countdowns, and study records</em>
</p>

![Relatum custom gradients and image backgrounds](docs/images/relatum-backgrounds.png)

## Quick start

### Download the Windows app

1. [Download the latest `Relatum-release.zip`](https://github.com/yamibk/Relatum-Opensource/releases/latest/download/Relatum-release.zip).
2. Fully extract the ZIP into a writable folder.
3. Run `Relatum.exe`.

Relatum supports Windows 10/11 and requires Microsoft Edge WebView2 Runtime, which is normally included with modern Windows installations.

> Do not overwrite an old installation in place. Keep the old `data/` and `canvases/` folders until you have confirmed that the new version works, then migrate your personal data.

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
- `data/` for recent items, study records, calendar data, window state, and AI configuration.

Both directories are excluded by `.gitignore` and are not part of the source repository. See the [privacy documentation](docs/PRIVACY.md) for the complete data boundary.

## Build the Windows desktop app

Desktop builds support Python 3.9–3.12. The build script creates a temporary environment and installs pinned versions of PyWebView, PyInstaller, and Pillow:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-desktop.ps1
```

The output is placed in the sibling `Relatum-release/` directory. User `data/` and `canvases/` are never bundled into the release.

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
