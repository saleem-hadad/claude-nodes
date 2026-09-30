# Claude Nodes

A spatial board for your Claude Code sessions. Each project is a local repo shown as a macOS-style folder; open one to see its sessions as cards on an infinite canvas.

- **Projects as folders.** Finder-style icon grid: double-click (or ⌘O) to open, Enter to rename, right-click for colour, Reveal in Finder, and remove. Drop a folder onto the window to add it.
- **Sessions as cards.** 4:3 cards on a Miro-like canvas: two-finger scroll pans, pinch zooms, drag on empty space box-selects.
- **Archive zone.** Every existing session for the repo is imported into the archive. Drag a card out to make it active, or drag it in to archive it (this stops its process).
- **Real terminal.** Click an active card to open the actual `claude` TUI in a modal. Sessions keep running when the modal is closed.
- **Live status dot.** 🟠 working, 🔴 needs you (permission prompt or question), 🔵 done. Archived cards are always done.
- **New session from context.** Select one or more cards and choose *New session from context*. Each session summarizes itself in a forked, non-persisted copy, so the originals are untouched. You review and edit the combined handoff, add an instruction, and a new session starts with it. Lineage edges link the new card to its sources.

## Run

Requires Node 22+ (see `.nvmrc`), pnpm, and the `claude` CLI signed in.

```sh
pnpm install
pnpm dev        # development with hot reload
pnpm build && pnpm start
```

`CLAUDE_NODES_USER_DATA=/some/dir pnpm dev` keeps app state separate, for testing.

## Shortcuts

| Where | Keys |
| --- | --- |
| Anywhere | ⌘⇧N add project · ⌘W close modal / back to projects |
| Board | ⌘N or N new session · double-click canvas new session here · ⌘A select all active · ⌫ archive selection · Enter open · Esc clear selection |
| Terminal | Shift+Enter newline in prompt · ⌘K clear · Esc goes to Claude (interrupt), so it never closes the modal |

## How it works

```
src/
  shared/     types.ts + api.ts: the typed IPC contract (window.api)
  preload/    contextBridge implementation of the contract
  main/       Electron main process
    env.ts        login-shell env + claude binary lookup (strips nested-session vars)
    discovery.ts  parses ~/.claude/projects/<encoded-repo>/*.jsonl into card metadata; watches for changes
    board.ts      merges disk sessions with the saved board; archive grid layout
    pty.ts        node-pty processes: `claude --session-id` / `--resume`, output ring buffer for replay
    hooks.ts      localhost hook server + status machine
    summarize.ts  `claude -p --resume <id> --fork-session --no-session-persistence`
    store.ts      state.json in the app's userData dir
  renderer/src/
    views/        ProjectsView (folders), BoardView (React Flow canvas)
    components/   TitleBar, FolderIcon, board/* (cards, archive zone, merge dialog, lineage edges)
    terminal/     xterm.js registry, TerminalModal, TranscriptPreview
```

**Status** comes from Claude Code hooks, not from screen scraping. Each process is launched with `--settings` that register `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification`, `Stop` and `SessionEnd` hooks. These POST to a token-protected server on 127.0.0.1. Your own settings and hooks still apply.

**Session data** stays where Claude Code keeps it. The app only stores board layout (positions, archive, titles, lineage) in `~/Library/Application Support/Claude Nodes/state.json`. *Remove from board* hides a card; it never deletes a transcript.

## Known limitations

- Status is tracked only for sessions launched from the app. A session running in another terminal shows as done.
- Running `/clear` inside a card starts a new session id, which appears as a new archived card.
- The first session in a repo Claude hasn't seen yet shows Claude's folder-trust prompt.
