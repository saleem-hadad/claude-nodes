# How Claude Nodes works

The details behind the [README](../README.md): what the app runs, where status comes from, every shortcut, and how to work on the code.

```mermaid
flowchart LR
  subgraph app["Claude Nodes"]
    ui["Renderer<br/>React Flow · xterm.js"]
    main["Main process"]
  end
  subgraph host["Session host · outlives the app"]
    ptys["node-pty"]
    hooks["Hook server<br/>127.0.0.1 + token"]
  end
  cli["claude<br/>one process per active card"]
  jsonl[("~/.claude/projects/…/*.jsonl")]

  ui <-->|IPC| main
  main <-->|Unix socket| host
  ptys --> cli
  cli -->|hooks POST via curl| hooks
  cli -->|writes transcripts| jsonl
  jsonl -->|parse + watch| main
```

## Sessions

Sessions are ordinary Claude Code sessions. New cards run `claude --session-id <uuid>`, and resuming runs `claude --resume <id>`, so you can continue the same session from any terminal later. Your own settings, hooks and MCP servers still apply.

## Sessions keep running after you quit

The app doesn't run sessions itself. A background process, the session host, owns their terminals, so quitting Claude Nodes (or a crash) leaves them running. Open the app again and the cards are still live, with their recent output and an up-to-date status.

The host starts with the first session you open, and runs Claude Nodes' own binary as plain Node, so it has no Dock icon. It also receives the sessions' hooks, and keeps them along with the keypresses that move status (Esc, Ctrl+C, Enter and number keys), so a relaunched app can work out each session's status. The host exits by itself once no sessions are left and the app isn't open. **Quit and Stop Sessions** (⌥⌘Q) stops every session along with the app.

## Terminal cards

Terminal cards run `$SHELL -l` in the repo folder with your login-shell environment. They get no hooks and have no transcript, so they have no status dot. A terminal whose shell has exited starts a fresh shell when you reopen it.

## Expanded cards

A card can expand in place to show its terminal on the board, so you can watch several sessions at once. It's the same terminal as the modal's, so moving between the two keeps the screen. Drag a card's edges or corners to resize it. The board saves each card's size and whether it's expanded. After a restart, an expanded card whose session is still running shows its terminal right away. One whose session has stopped waits for you to click **Resume session** or **Start shell** before it starts anything.

## Status

Status comes from hooks that the app adds for its own processes with `--settings`. Each hook POSTs its payload to a token-protected server on 127.0.0.1, run by the session host:

| Hook | Status |
| --- | --- |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | 🟠 Working |
| `PermissionRequest`, `Notification` (permission or question), `PreToolUse` for `AskUserQuestion` | 🔴 Needs you |
| `Stop`, `SessionEnd`, process exit | 🔵 Done |

Interrupting with Esc or Ctrl+C doesn't fire a hook, so the app watches for those keystrokes as well.

Hooks that fire inside a subagent carry its `agent_id`. Those drive the agent's own status instead (`SubagentStart` and its tool hooks for working, `SubagentStop` for done), and a card reads as working or needing you while any of its agents does.

## Agents

When Claude starts agents with its Agent tool, Claude Code keeps each one's transcript beside the session's, in `<session id>/subagents/agent-<id>.jsonl`, with a `.meta.json` holding its type and the description Claude gave it. The app watches those files.

The agents of the current run (still running, or finished since your last prompt) peek out from under the session's card as a deck, each layer in its status colour. Point at the deck, or the agent count in the card's footer (the 🤖 button in an expanded card's title bar), to fan the agents out beside the card with what each is doing. Click to pin the fan open. Click an agent for the agents viewer: every agent the session has started, with the selected one's task, tool calls and replies, updating while it works. Right-click a card and choose **Agents** to open the viewer for an archived session.

An agent that ends its turn with a command still running in the background isn't done: the command wakes it again when it finishes, so it stays 🟠 meanwhile.

## Notes

Each board has a pad of sticky notes under the archive, and it moves with the archive. Drag the top note off the pad and drop it anywhere on the board, or click the pad for one beside it. A new note opens for writing. Enter starts a new line, and Escape, ⌘Enter or a click away puts the note down. Double-click a note (or select it and press Enter) to write in it again. Drag it to move it, and drag a selected note's corners to resize it. Right-click it to change its colour or delete it. Deleting a note that has writing on it asks first.

Notes sit on top of cards. They don't join sections or the archive: a note dropped on the archive or the pad goes back where it was.

## Cards

Cards are read from Claude Code's transcripts in `~/.claude/projects/<encoded-repo-path>/`. Titles use your custom title first, then Claude's generated title, then the first prompt. Parsing is incremental and cached, so large histories load quickly.

## New session from context

For each selected session the app runs `claude -p --resume <id> --fork-session --no-session-persistence`, at most three at a time. The fork writes a handoff summary and is then thrown away, so the original session is never touched. You review and edit the combined summaries, and they become the new session's first prompt.

This makes one Claude request per selected session, so it counts toward your Claude usage like any other prompt.

## Actions

The Actions dock on the board's right edge holds a project's buttons. A project starts with none. **Add action** asks what the button should do, with a few examples to start from. Claude (`claude -p`, Sonnet, able to read the repo but not change it) drafts a name, an icon, the prompt each press runs, and the permission rules it needs, such as `Bash(git pull *)`. You review and edit all four before saving. Actions are stored with the project in `state.json`, not in the repo.

Pressing a button starts an ordinary session card on the action's prompt, in a section named after it. The run gets:

- the action's permission rules through `--allowedTools`. Anything else stops the run to ask you, and its card turns 🔴.
- the board tools, through `--mcp-config`: `list_sessions` and `archive_sessions`. They're served by the app on 127.0.0.1, with a token for each run that covers only its own project. The token sits in a file only you can read (`runs/` in the app's data folder), so it never shows up in a process listing.
- a note asking it to work without stopping to chat, to ask with AskUserQuestion when it needs you, and to end with a one-line summary.

When the run's turn ends, its card and section leave the board, its transcript is hidden like a removed card's, and the summary shows as a notice. If you type into a run, or interrupt it with Esc or Ctrl+C, it becomes yours: it stays on the board as an ordinary session, and loses its board tools. Answering a question it asked doesn't count. While a run is on the board, pressing its button again opens it rather than starting another.

## Your data

Transcripts stay where Claude Code keeps them. The app stores only the board layout (projects, card positions, sections, notes, archive, custom titles and lineage) and its settings (theme) in `~/Library/Application Support/Claude Nodes/state.json`. *Remove from board* hides a card and never deletes a transcript.

The session host keeps its socket and log in the `host` folder next to it. Only your user can open the folder, which matters because anything that can connect to the socket can start processes as you.

## Shortcuts

| Where | Action | Shortcut |
| --- | --- | --- |
| Anywhere | Add a project | ⌘⇧N |
| | Settings (theme: System, Light or Dark) | ⌘, |
| | Quit and stop every session | ⌥⌘Q |
| | Close the modal, or go back to projects | ⌘W |
| Projects | Open the selected project | Double-click · ⌘O · ⌘↓ |
| | Rename · remove | Enter · ⌘⌫ |
| | Color, Reveal in Finder | Right-click |
| Board | New session | N · ⌘N · double-click empty canvas |
| | New terminal in the project folder | T · ⌘T |
| | Open a card | Click · Enter |
| | Expand a card on the board, or collapse it | E · the card's ⤢ button |
| | Resize an expanded card | Drag its edges or corners |
| | Select | Drag on empty canvas · ⇧-click · ⌘-click · ⌘A (all active) |
| | Group the selection into a section | ⌘G |
| | Archive the selection | ⌫ |
| | Search the archive | Hover the stack and type · Esc |
| | Rename a card | Double-click its title |
| | New note | Drag one off the pad under the archive · click the pad · right-click › New note here |
| | Write in a note | Double-click it · Enter |
| | Delete the selected notes | ⌫ |
| | Fan out a card's agents | Point at the deck under it · click to pin |
| | Pan · zoom | Two-finger scroll, Space-drag or middle-drag · pinch |
| Terminal | Newline in Claude's prompt | ⇧Enter |
| | Clear · copy · select all | ⌘K · ⌘C · ⌘A |
| New session from context | Start | ⌘Enter |

In the terminal, Esc goes to Claude (it interrupts a turn), so it never closes the modal. ⌘W never closes the window.

## Known limitations

- Status is tracked only for sessions started from the app. A session running in another terminal shows as done.
- Running `/clear` inside a card starts a new session id, which shows up as a new archived card.
- In a repo Claude Code hasn't opened before, the first session shows Claude's folder-trust prompt. "No, exit" is preselected, so move to "Yes" before pressing Enter.
- If you update the app while sessions are running, and the update changed how the app talks to the session host, the new version asks to stop those sessions before it continues.
- Built and tested on macOS only.

## Project layout

```
src/
  shared/       types.ts + api.ts: the typed IPC contract (window.api)
  preload/      contextBridge implementation of the contract
  main/         Electron main process
    env.ts        login-shell environment and claude binary lookup
    discovery.ts  parses transcripts into card metadata and watches for changes
    agents.ts     subagent transcripts: what each agent is doing, and its status
    board.ts      merges sessions on disk with the saved board; archive layout
    pty.ts        the app's side of the session host: output buffers replayed into terminals, input, status replay
    host.ts       the session host, a separate process: node-pty processes and the hook server
    hostProtocol.ts  messages between the two over a Unix socket
    hooks.ts      the status machine, driven by hooks the session host passes on
    summarize.ts  forked, non-persisted handoff summaries
    actions.ts    the Actions dock's buttons: drafting them with Claude, and each run's extra claude options
    boardTools.ts the MCP server that lets an action run list and archive the board's sessions
    store.ts      state.json in the app's userData directory
  renderer/src/
    views/        ProjectsView (folders) and BoardView (canvas)
    components/   title bar, folder icon, board cards, agent decks, sections, archive stack, notes and their pad, merge dialog, lineage edges
    terminal/     xterm.js registry, TerminalModal, TranscriptPreview, AgentViewer
```

Built with Electron, electron-vite, React, TypeScript, [React Flow](https://reactflow.dev), [xterm.js](https://xtermjs.org), [node-pty](https://github.com/microsoft/node-pty) and zustand.

## Development

You need macOS, [Node.js](https://nodejs.org) 22+ and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm dev          # run with hot reload
pnpm build        # production build into out/
pnpm start        # run the production build
pnpm typecheck    # type-check main, preload and renderer
pnpm dist         # build the arm64 and x64 DMGs into dist/
```

`CLAUDE_NODES_USER_DATA=/some/dir pnpm dev` keeps app state separate from your real board, which is useful for testing. It gets its own session host too.

A running session host keeps the code it started with. After changing `host.ts`, use **Quit and Stop Sessions** so the next session starts a fresh host. Bump `PROTOCOL` in `hostProtocol.ts` whenever a message changes shape.

`pnpm dist` writes `dist/Claude-Nodes-arm64.dmg` and `dist/Claude-Nodes-x64.dmg`, with the unpacked apps in `dist/mac-arm64/` and `dist/mac/`. The apps are ad-hoc signed and not notarized, so a downloaded copy needs **Open Anyway** in Privacy & Security on first launch. The packaged app shares its board with `pnpm dev`, so don't run both at once.

### Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds both DMGs and attaches them to the GitHub release for that tag. The README's download links point at `releases/latest/download/`, so they pick up each new release.

```sh
npm version 0.2.0       # bumps package.json, commits, tags v0.2.0
git push --follow-tags
```

The workflow fails if the tag doesn't match the version in `package.json`.

### Troubleshooting installs

- **Wrong Node version.** Node 20 breaks Electron's installer and makes pnpm skip Vite's native binding. If a build fails with "Cannot find native binding", switch to Node 22 and run `rm -rf node_modules && pnpm install`.
- **`posix_spawnp failed`.** pnpm drops the execute bit on node-pty's `spawn-helper`. `scripts/postinstall.cjs` restores it, and also downloads Electron's binary, because pnpm 10 skips dependency build scripts. Run `pnpm install` again if either step was skipped.
