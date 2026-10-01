<div align="center">

<img src="build/icon.png" width="96" alt="">

# Claude Nodes

**A spatial board for your Claude Code sessions.**

See every session in a repo at once, spot the ones waiting on you,<br>
and start new sessions from the context of old ones.

</div>

https://github.com/user-attachments/assets/cbbd89ac-9096-4cfe-8c6a-4f6a73e9c7f8

<table>
  <tr>
    <td colspan="2">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/board-dark.png">
        <img src="docs/screenshots/board.png" alt="The board: a card per session, grouped into sections, with the archive stack on the left">
      </picture>
      <p align="center">Every session in the repo on one board. Red cards need you.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/terminal-dark.png">
        <img src="docs/screenshots/terminal.png" alt="A card open in the terminal modal, with Claude asking for permission">
      </picture>
      <p align="center">Click a card for the real <code>claude</code> TUI.</p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/expanded-dark.png">
        <img src="docs/screenshots/expanded.png" alt="A card expanded on the board, showing its terminal">
      </picture>
      <p align="center">Or expand it in place and watch it work.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/context-dark.png">
        <img src="docs/screenshots/context.png" alt="The new session from context dialog with handoff summaries of two sessions">
      </picture>
      <p align="center">Start a session from the context of others.</p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/archive-dark.png">
        <img src="docs/screenshots/archive.png" alt="The archive stack open with search results for 404">
      </picture>
      <p align="center">Search the archive and drag a session back out.</p>
    </td>
  </tr>
</table>

## Features

- **A card per session** with Claude's latest reply, the branch and the last activity. Arrange cards and group them into sections.
- **Live status** from Claude Code hooks: 🟠 working · 🔴 needs you · 🔵 done.
- **The real terminal.** Click a card to open the actual `claude` TUI, or expand it right on the board and resize it. Press **T** for a shell in the project folder.
- **New session from context.** Select a few cards and start a session that already knows what they did.
- **A searchable archive.** Old sessions stack up in one pile. Drag a card out to pick it up again.

## Get started

**[Download for Apple Silicon](https://github.com/saleem-hadad/claude-nodes/releases/latest/download/Claude-Nodes-arm64.dmg)** · [Intel](https://github.com/saleem-hadad/claude-nodes/releases/latest/download/Claude-Nodes-x64.dmg)

Open the DMG and drag Claude Nodes into Applications. You also need [Claude Code](https://code.claude.com/docs/en/overview) with `claude` on your `PATH`.

The app isn't notarized yet, so macOS blocks the first launch. Open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.

Click **New Project**, pick a repo and open it. Press **N** for a new session, or drag one out of the archive to resume it.

To build from source, see [Development](docs/how-it-works.md#development).

## Shortcuts

| Action | Shortcut |
| --- | --- |
| New session · new terminal | N · T |
| Open a card | Click · Enter |
| Expand a card on the board · collapse it | E |
| Select cards | Drag on empty canvas · ⇧-click |
| Group the selection into a section | ⌘G |
| Archive the selection | ⌫ |
| Search the archive | Hover the stack and type |

## Learn more

Everything stays on your machine. The app reads transcripts where Claude Code keeps them and saves only the board layout.

[How it works](docs/how-it-works.md) covers the architecture, every shortcut, known limitations and development.
