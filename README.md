# Task History for Claude Code

A Claude Code mod that keeps a compact, collapsible history of the tasks you
gave the current session, in a pane beside the chat. Each entry shows what you
asked, what came of it, what Claude is waiting for, which files changed and how
long it took, so you can keep track of a long session (or several sessions side
by side) without scrolling back through the whole transcript.

```
╭ Tasks · my-project ─────────────────╮
│ ▸ ⟳ Build task history mod     2m14s│  ← running now, live
│     5 tools · 1 file                │
│ ▸ ? Fix the login bug             12m│  ← Claude is waiting for you
│     Add a regression test as well?  │
│ ▾ ✓ Translate the README          40m│  ← expanded
│     → Translated to English, FAQ    │
│       shortened                     │
│     done · 1m12s · 6 tools          │
│     ▸ 2 files changed               │  ← expands to the paths
│     ▸ Prompt                        │  ← expands to the full prompt
│     ↳ “also make the FAQ shorter”   │  ← a follow-up, grouped
│ ▸ ✓ Update composer packages      1h│
╰─────────────────────────────────────╯
```

## Features

- **One line per task**, newest first: status, short title, and the running
  time (while it runs) or its age.
- **Expand a task** to see a one-line result, the questions or next steps
  Claude left open, duration and tool calls. The changed files and the full
  original prompt each fold out one level deeper.
- **Status at a glance:** `⟳` running, `✓` done, `?` Claude ended with a
  question and waits for you, `✗` interrupted or failed. A waiting task shows
  its open question even when collapsed.
- **Follow-ups are grouped.** Short replies (“yes”, “ok, go on”, “B”) and
  corrections to the same task are listed under that task as `↳` lines instead
  of becoming tasks of their own.
- **AI summaries.** When a task finishes, a small model (Haiku by default)
  turns the prompt and Claude's final reply into a short title, a one-line
  result and the open points, in the language of your prompt. Until it
  answers, or if it fails, the raw prompt and the reply's first line are shown.
- **Insert a prompt again:** the expanded prompt has an *Insert into prompt*
  button that puts it back into the input box.
- **Notifications.** When a task that ran for 20 seconds or more ends, a
  desktop notification says so: `? <question>` when Claude waits for you,
  `✓ <title> – <result>` when it is done. Handy when several sessions run side
  by side.
- **Status line.** The running or waiting task also shows in the status line
  (`⟳ Fix the login bug · 1m12s`), so it stays visible with the pane closed.
- **All changed files.** Besides `Edit`, `Write` and `NotebookEdit`, the mod
  compares `git status` before and after each turn, so files changed by shell
  commands (`sed`, `mv`, a formatter, a generator) are listed too.
- **Survives resumes and reloads.** The history is saved per session, so
  `claude --resume` brings it back. A summary cut off by a reload or update is
  asked for again. A session that ran before the mod was on is rebuilt from its
  transcript (raw text, no summaries).

## Requirements

- Claude Code with mods (function hooks): tested with 2.1.307.
- **For the right-hand column, the terminal's fullscreen layout** and a window
  at least 110 columns wide. The pane opens by itself there. On the terminal's
  main screen (no fullscreen layout, e.g. inside tmux by default) Claude Code
  places panes inline above the prompt instead; open it there with `/history`.
- The pane is also drawn in the desktop app's Code tab and in the VS Code
  extension. Where it sits there is up to the app.
- The mod works only in Claude Code, not in the claude.ai chat.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install task-history --marketplace crysix/claude-task-history
```

Answer `y` to add the marketplace, then pick a scope (the user scope makes it
available in every session).

From a shell:

```
claude plugin install task-history --marketplace crysix/claude-task-history
```

In the desktop app, where `/plugin` does not run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with
`crysix/claude-task-history`, then **Add plugin**. A mod installed from a
terminal at the user scope loads in the desktop app's local sessions too, as
long as both use the same Claude Code configuration.

**Windows with WSL:** Claude Code in WSL and the desktop app on Windows keep
separate configurations (`~/.claude` in WSL, `%USERPROFILE%\.claude` on
Windows). Install the mod on each side you use: with `/plugin install` in a WSL
terminal, and through **+ › Plugins** in the desktop app.

**Updating:** `claude plugin update task-history@claude-task-history`, then
`/reload-plugins` in a running session.

## Usage

| Command          | What it does                                   |
| ---------------- | ---------------------------------------------- |
| `/history`       | Show or hide the pane                          |
| `/history open`  | Show the pane                                  |
| `/history close` | Hide the pane                                  |
| `/history clear` | Empty the history of the current session       |

`/history` runs at once, even while Claude is working.

**Mouse:** in the terminal, click a task to expand or collapse it, and click
*files changed* or *Prompt* to fold those out. In the desktop app and VS Code,
click the `▸` / `▾` arrow in front of the row.

**Keyboard:** give the pane the keyboard with `ctrl+x` then `tab` (or a click).
`Tab` walks the rows, `Enter` expands or collapses, the arrow keys scroll and
`Esc` returns to the prompt.

If you close the pane by hand, it stays closed in later sessions until you open
it again with `/history`.

## How it works

The mod listens to the session's own events. Nothing is scraped from the
screen.

| Event           | What the mod does                                                                 |
| --------------- | --------------------------------------------------------------------------------- |
| `prompt.submit` | Remembers what you typed, slash commands as typed (`/review 42`)                   |
| `turn.start`    | Starts a new task, or adds a follow-up to the last task                            |
| `tool.call`     | Counts tool calls and collects the files `Edit`, `Write` and `NotebookEdit` changed |
| `turn.complete` | Records duration, status and the files `git status` shows as changed, then asks for the summary |

**What counts as a new task.** Every prompt you send starts a turn. A turn is
added to the last task as a follow-up when:

1. the prompt is a short acknowledgement (`ja`, `ok`, `yes`, `mach weiter`,
   `go ahead`, a single letter or number, ...), or
2. you typed it while Claude was still working on the task, or
3. the summary model judges it a continuation, answer or correction of the task
   before it. In that case the task is merged into the previous one once the
   summary arrives.

Turns Claude starts on its own (a background task finishing, for example)
continue the task that is there. Subagents never become tasks; their tool calls
count towards the task that started them.

**Storage.** The tasks of the running session are held in the mod's session
state. They are saved in the mod's own store (a JSON file in your Claude Code
configuration folder) under the session's id, for the last 30 sessions. Prompts
are kept up to 4,000 characters.

## Configuration

| Option         | Default | Meaning                                                                 |
| -------------- | ------- | ----------------------------------------------------------------------- |
| `summaries`    | `true`  | Summarize finished tasks with a model. `false`: raw text, no model calls |
| `summaryModel` | `haiku` | The model alias or id used for summaries                                 |
| `notify`       | `all`   | Notifications for tasks of 20 s or more: `all`, `waiting` (only when Claude asks you something), `off` |
| `statusLine`   | `true`  | Show the running or waiting task in the status line                      |
| `gitFiles`     | `true`  | Find changed files through `git status` before and after each turn       |

You set these when you install the mod, or later in `/config`. They are stored
in your `settings.json` under `pluginConfigs`.

Claude Code has notifications of its own (when it waits for your input). If you
get two, set `notify` to `off` or `waiting`.

## Cost and privacy

One small model call is made per finished turn, through the session's own API
client and credentials (the same provider and account as the session itself).
It sends the request (up to about 3,000 characters), your follow-ups, the
previous task's title and result, and an excerpt of Claude's final reply (up
to about 4,000 characters), and asks for at most 500 tokens back. With Haiku
that is a fraction of a cent per task. Set `summaries` to `false` to make no
calls at all.

## Limitations

- Only the current session is shown, not other sessions running in parallel.
- Changed files through git work only inside a git repository. There, a file
  that was already modified before the turn and is changed again by a shell
  command is not detected, and files you edit yourself while Claude works are
  counted towards the task.
- Times are relative (`12m`, `3h`), not clock times.
- Grouping by the model can be wrong now and then. A wrongly merged task still
  shows its prompt as a `↳` line under the task it was merged into.

## Development

```
.claude-plugin/plugin.json       manifest and options
.claude-plugin/marketplace.json  makes this repository installable
hooks/hooks.json                 names the hooks module
hooks/register.tsx               events, persistence, the pane
hooks/logic.ts                   grouping, summaries, formatting (pure)
types/index.d.ts                 the task type and the mod's state contract
tests/task-history.test.tsx      tests on the terminal and desktop surfaces
```

```
claude plugin validate .      # what the engine reads and would refuse
claude plugin test .          # run the tests
claude --plugin-dir .         # a session with the mod loaded from this folder
```

A session started with `--plugin-dir` reloads the mod when you save a file.

## Author

Made by [crysix](https://github.com/crysix).

## License

[MIT](LICENSE)
