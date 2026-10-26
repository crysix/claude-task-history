import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Task, TaskStatus } from '../types'
import type { NotifyLevel } from './logic'
import type { Part } from './row'
import {
  addTask,
  applySummary,
  changedPaths,
  clockTime,
  cut,
  dayLabel,
  escapeMarkdown,
  excerpt,
  firstLine,
  formatAge,
  formatDuration,
  isAck,
  isSameDay,
  markReplied,
  newTask,
  normalize,
  notification,
  oneLine,
  parseGitStatus,
  patch,
  parseSummary,
  projectName,
  promptKey,
  relativePath,
  statusText,
  SUMMARY_SYSTEM,
  summaryPrompt,
  tasksFromMessages,
  timeSpan,
} from './logic'

const PANE = 'task-history'
const COMMAND = 'history'
const SESSIONS_KEY = 'sessions'
const OPEN_KEY = 'isOpen'
const KEEP_SESSIONS = 30
const TICK_MS = 15000
/** A turn shorter than this raises no notification: the person is still looking. */
const NOTIFY_AFTER_MS = 20000

/** Turns the person did not ask for: they carry on the task that is there. */
const CONTINUATIONS = new Set(['task-notification', 'auto-continuation', 'observer', 'observer-activity'])

const ICONS: Record<TaskStatus, { glyph: string; color: string; word: string }> = {
  running: { glyph: '⟳', color: 'claude', word: 'running' },
  done: { glyph: '✓', color: 'success', word: 'done' },
  waiting: { glyph: '?', color: 'warning', word: 'waiting for you' },
  aborted: { glyph: '✗', color: 'inactive', word: 'interrupted' },
  error: { glyph: '✗', color: 'error', word: 'failed' },
}

const tasks = atom({ plugin: 'task-history', key: 'tasks' } as const, [])
const activeId = atom({ plugin: 'task-history', key: 'activeId' } as const, null)
const sessionId = atom({ plugin: 'task-history', key: 'sessionId' } as const, '')
const expanded = atom({ plugin: 'task-history', key: 'expanded' } as const, [])
const tick = atom({ plugin: 'task-history', key: 'tick' } as const, 0)

type Engine = EngineInterface

type Submitted = { text: string; isPrompt: boolean; isCommand: boolean; at: number }

function cutStart(text: string, length: number): string {
  return text.length > length ? `…${text.slice(text.length - length + 1)}` : text
}

// Module state: a reload starts it over, which costs nothing worth keeping.
let model = 'haiku'
let isSummarizing = true
let notifyLevel: NotifyLevel = 'all'
let isStatusLine = true
let isGitTracking = true
let isResultLine = true
// The repository's top folder: unknown until asked, null outside a repository.
let gitRoot: string | null | undefined
// `git status` as the running turn found it at its start.
let gitBefore: { turnId: string; entries: Map<string, string> } | undefined
// Prompts typed while a turn ran: they belong to that turn's task.
const folded = new Set<string>()
// The last prompt sent while idle, which the next turn starts with.
let submitted: Submitted | undefined
let wantsPane = true
let hasAutoOpened = false
let hasLoggedFailure = false
// Surfaces where the pane's row module failed: they get links instead.
const faulted = new Set<string>()
// Surfaces whose conversation cannot be scrolled to a prompt: they show no jump.
const jumpless = new Set<string>()
// The transcript rows of prompts no task has taken yet, newest last.
const promptRows: { key: string; uuid: string; at: number }[] = []
/** A prompt's row is kept just before its turn starts; one older than this belongs to an earlier prompt. */
const PROMPT_ROW_MS = 60000
let cwd = ''

function paneTitle() {
  return `Tasks · ${projectName(cwd)}`
}

async function persist($: Engine) {
  const id = await read($, sessionId)

  if (!id) {
    return
  }

  const list = await read($, tasks)
  const stored = await $.store.get(SESSIONS_KEY)
  const listed = Array.isArray(stored) ? stored.filter((one): one is string => typeof one === 'string') : []
  // A session saved while another process rewrote the index is missing from it: it counts as the oldest.
  const unlisted = (await $.store.keys())
    .filter(key => key.startsWith('session:'))
    .map(key => key.slice('session:'.length))
    .filter(one => !listed.includes(one))
  const known = [...unlisted, ...listed]

  if (list.length === 0 && !known.includes(id)) {
    return
  }

  const sessions = [...known.filter(one => one !== id), id]

  for (const old of sessions.slice(0, -KEEP_SESSIONS)) {
    await $.store.delete(`session:${old}`)
  }

  try {
    await $.store.set(`session:${id}`, list)
  } catch {
    // The store is full: let the oldest sessions go and try once more.
    for (const old of sessions.slice(0, Math.ceil(sessions.length / 2))) {
      if (old !== id) {
        await $.store.delete(`session:${old}`)
      }
    }

    await $.store.set(`session:${id}`, list)
  }

  await $.store.set(SESSIONS_KEY, sessions.slice(-KEEP_SESSIONS))
}

/** Loads the tasks of the session running now, after a start, a /clear or a resume. */
async function syncSession($: Engine) {
  const id = await $.session.id()

  if (id === (await read($, sessionId))) {
    return
  }

  const stored = await $.store.get(`session:${id}`)
  let list: Task[] = Array.isArray(stored) ? (stored as Task[]) : []

  if (list.length === 0) {
    list = tasksFromMessages(await $.session.messages(), await $.clock.now())
  }

  // Nothing runs in a session that was just loaded.
  list = list.map(task => (task.status === 'running' ? { ...task, status: 'aborted', runningSince: null } : task))

  await update($, sessionId, () => id)
  await update($, tasks, () => list)
  await update($, activeId, () => null)
  await update($, expanded, () => [])
  await updateStatus($)
}

async function resumeTask($: Engine, id: string, now: number, isReply: boolean) {
  await update($, tasks, list =>
    patch(list, id, task => ({ ...(isReply ? markReplied(task) : task), status: 'running', runningSince: now })),
  )
  await update($, activeId, () => id)
}

async function addFollowUp($: Engine, id: string, text: string, now: number) {
  await update($, tasks, list =>
    patch(list, id, task => ({ ...task, followUps: [...task.followUps, { text: text.slice(0, 2000), at: now }] })),
  )
}

async function summarize($: Engine, id: string, answer: string, turnMs: number) {
  const list = await read($, tasks)
  const index = list.findIndex(task => task.id === id)
  const task = list[index]

  if (task === undefined) {
    return
  }

  const previous = task.needsGrouping && index > 0 ? list[index - 1] : undefined
  let target = id

  try {
    const reply = await $.model.complete({
      model,
      system: SUMMARY_SYSTEM,
      prompt: summaryPrompt(task, answer, previous),
      maxTokens: 500,
      effort: 'low',
      timeoutMs: 30000,
    })

    if (!reply.isAnswered) {
      throw new Error(reply.reason)
    }

    const summary = parseSummary(reply.text)

    if (summary === undefined) {
      throw new Error('the reply held no summary')
    }

    let mergedInto: string | undefined

    await update($, tasks, current => {
      const applied = applySummary(current, id, summary)
      mergedInto = applied.mergedInto

      return applied.tasks
    })

    const merged = mergedInto

    if (merged !== undefined) {
      target = merged
      await update($, activeId, current => (current === id ? merged : current))
      await update($, expanded, keys => keys.map(key => (key === id ? merged : key)))
    }
  } catch (error) {
    if (!hasLoggedFailure) {
      hasLoggedFailure = true
      $.ui.log(`task-history: no summary (${error instanceof Error ? error.message : String(error)}); raw text stays`)
    }
  }

  // Done either way: a summary that failed is not asked again.
  await update($, tasks, current => patch(current, target, one => ({ ...one, pendingAnswer: null })))
  await persist($)
  await updateStatus($)
  await notify($, target, turnMs)
}

/** Asks again for the summaries a reload cut off (its timers go with the old module). */
async function retryPending($: Engine) {
  for (const task of await read($, tasks)) {
    const answer = task.pendingAnswer

    if (isSummarizing && typeof answer === 'string' && answer && task.status !== 'running') {
      $.clock.after(1, () => void summarize($, task.id, answer, 0))
    }
  }
}

async function updateStatus($: Engine) {
  if (!isStatusLine) {
    return
  }

  const list = await read($, tasks)
  const id = await read($, activeId)
  const task = list.find(one => one.id === id) ?? list.at(-1)

  $.ui.status(statusText(task, await $.clock.now()))
}

async function notify($: Engine, id: string, turnMs: number) {
  if (turnMs < NOTIFY_AFTER_MS) {
    return
  }

  const task = (await read($, tasks)).find(one => one.id === id)
  // A task the person replied to already needs no notification: they have seen it.
  const text = task === undefined || task.isReplied === true ? undefined : notification(task, notifyLevel)

  if (text !== undefined) {
    await $.ui.notify(text, { title: `Claude · ${projectName(cwd)}` })
  }
}

async function gitStatus($: Engine): Promise<Map<string, string> | undefined> {
  if (!isGitTracking) {
    return undefined
  }

  try {
    if (gitRoot === undefined) {
      const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
      gitRoot = top.exitCode === 0 && top.stdout.trim() ? top.stdout.trim().replace(/\\/g, '/') : null
    }

    if (gitRoot === null) {
      return undefined
    }

    const status = await $.process.run(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: gitRoot,
      timeoutMs: 5000,
    })

    return status.exitCode === 0 && !status.isStdoutTruncated ? parseGitStatus(status.stdout) : undefined
  } catch {
    return undefined
  }
}

async function snapshotGit($: Engine, turnId: string) {
  gitBefore = undefined
  const entries = await gitStatus($)

  if (entries !== undefined) {
    gitBefore = { turnId, entries }
  }
}

/** The files the turn changed by any means, Bash included, by `git status` before and after. */
async function gitChanges($: Engine, turnId: string): Promise<string[]> {
  const before = gitBefore
  gitBefore = undefined

  if (before === undefined || before.turnId !== turnId) {
    return []
  }

  const after = await gitStatus($)
  const root = gitRoot

  return after === undefined || typeof root !== 'string'
    ? []
    : changedPaths(before.entries, after).map(path => `${root}/${path}`)
}

async function toggleRow($: Engine, key: string) {
  await update($, expanded, keys => (keys.includes(key) ? keys.filter(one => one !== key) : [...keys, key]))
}

async function fillPrompt($: Engine, id: string) {
  const task = (await read($, tasks)).find(one => one.id === id)

  if (task !== undefined) {
    await $.prompt.fill({ text: task.prompt })
  }
}

/** Puts what takes up an open point into the prompt: the summary's reply for it, else the point itself. */
async function fillPoint($: Engine, id: string, index: number) {
  const task = (await read($, tasks)).find(one => one.id === id)
  const text = task?.openPrompts?.[index] || task?.openPoints[index]

  if (text) {
    await $.prompt.fill({ text })
  }
}

/** Gives the task running now the transcript row of its prompt, or keeps the row for the task about to start. */
async function linkPrompt($: Engine, key: string, uuid: string) {
  const id = await read($, activeId)
  const task = (await read($, tasks)).find(one => one.id === id)

  if (task !== undefined && task.messageId === undefined && promptKey(task.prompt) === key) {
    await update($, tasks, list => patch(list, task.id, one => ({ ...one, messageId: uuid })))

    return
  }

  promptRows.push({ key, uuid, at: await $.clock.now() })

  if (promptRows.length > 10) {
    promptRows.shift()
  }
}

/** The transcript id of the newest recent prompt row with this key, taken off the list. */
function takePromptRow(key: string, now: number): string | undefined {
  const index = promptRows.findLastIndex(row => row.key === key && now - row.at < PROMPT_ROW_MS)

  return index < 0 ? undefined : promptRows.splice(index, 1)[0]?.uuid
}

/** Scrolls the conversation to the prompt that started a task; where it cannot, says so and stops offering it. */
async function jump($: Engine, surface: string, id: string) {
  const messageId = (await read($, tasks)).find(one => one.id === id)?.messageId

  if (messageId === undefined) {
    return
  }

  let deny: string | undefined
  let isUnsupported = false

  try {
    deny = (await $.ui.scroll({ to: { requestId: messageId }, block: 'start' })).deny
    isUnsupported = deny !== undefined && /no-surface|none scrolls|not person-initiated/.test(deny)
  } catch (error) {
    deny = error instanceof Error ? error.message : String(error)
    isUnsupported = true
  }

  if (deny === undefined) {
    return
  }

  $.ui.toast(`task-history: cannot show the prompt in the conversation (${deny})`)

  if (isUnsupported) {
    jumpless.add(surface)
    $.ui.invalidate('ui.render')
  }
}

async function refresh($: Engine) {
  const now = await $.clock.now()
  const isRunning = (await read($, tasks)).some(task => task.status === 'running')

  if (isRunning || now - (await read($, tick)) >= 60000) {
    await update($, tick, () => now)
  }

  if (isRunning) {
    await updateStatus($)
  }
}

export const register: Register = (on, options) => {
  isSummarizing = options.summaries !== false
  model =
    typeof options.summaryModel === 'string' && options.summaryModel.trim() ? options.summaryModel.trim() : 'haiku'
  notifyLevel = options.notify === 'waiting' || options.notify === 'off' ? options.notify : 'all'
  isStatusLine = options.statusLine !== false
  isGitTracking = options.gitFiles !== false
  isResultLine = options.resultLines !== false

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: COMMAND,
      description: 'Show or hide the task history pane',
      argumentHint: '[open|close|clear]',
      immediate: true,
    })
    wantsPane = (await $.store.get(OPEN_KEY)) !== false
    await syncSession($)
    await retryPending($)
    await updateStatus($)
    $.clock.every(TICK_MS, () => void refresh($))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await persist($)

    if (e.reason === 'clear' || e.reason === 'resume') {
      // The process goes on under another session: load its tasks once it has.
      await update($, sessionId, () => '')
      await update($, tasks, () => [])
      await update($, activeId, () => null)
      $.clock.after(500, () => void syncSession($))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isOwnCommand = e.command?.name === COMMAND

    if (!isOwnCommand) {
      const now = await $.clock.now()
      const text = e.command ? `/${e.command.name}${e.command.args ? ` ${e.command.args}` : ''}` : e.text
      const isPrompt = e.isMeta !== true && !CONTINUATIONS.has(e.origin.kind)
      const running = e.turnId !== undefined && !e.wait ? await read($, activeId) : null

      if (running !== null) {
        if (isPrompt) {
          folded.add(normalize(e.text))
          await addFollowUp($, running, text, now)
        }
      } else {
        submitted = { text, isPrompt, isCommand: e.command !== undefined, at: now }
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The row a prompt is kept as: its id is what the conversation scrolls back to.
  // The row is stored by `next` alone, so a failure after it costs the jump and nothing else.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const stored = await next(e)

    if (e.agentId === undefined && e.message.type === 'user' && e.message.isMeta !== true) {
      const text = e.message.content.map(block => (typeof block.text === 'string' ? block.text : '')).join('\n')
      await linkPrompt($, promptKey(text), e.uuid).catch(() => undefined)
    }

    return stored
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    await syncSession($)
    await snapshotGit($, e.turnId)

    const now = await $.clock.now()
    const typed = normalize(e.text)
    const entry = submitted
    submitted = undefined

    const matched =
      entry !== undefined && (normalize(entry.text) === typed || (entry.isCommand && now - entry.at < 15000))
        ? entry
        : undefined
    const last = (await read($, tasks)).at(-1)
    const text = matched?.text ?? e.text
    // Whatever the person sends next answers what the task in front waits on.
    const isReply = matched?.isPrompt !== false

    if (folded.delete(typed) || typed === '' || !isReply) {
      if (last !== undefined) {
        await resumeTask($, last.id, now, isReply)
      }
    } else if (last !== undefined && isAck(text)) {
      await addFollowUp($, last.id, text, now)
      await resumeTask($, last.id, now, true)
    } else {
      const messageId = takePromptRow(promptKey(text), now)
      const task = { ...newTask(e.turnId, text, now, last !== undefined), ...(messageId !== undefined && { messageId }) }
      await update($, tasks, list => addTask(last === undefined ? list : patch(list, last.id, markReplied), task))
      await update($, activeId, () => task.id)
    }

    await updateStatus($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const id = await read($, activeId)

    if (id === null) {
      return ran
    }

    const path = e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : undefined
    const changed = path !== undefined && ran.deny === undefined && ran.isError !== true ? path : undefined

    await update($, tasks, list =>
      patch(list, id, task => ({
        ...task,
        tools: task.tools + 1,
        files: changed !== undefined && !task.files.includes(changed) ? [...task.files, changed] : task.files,
      })),
    )

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined) {
      return result
    }

    const id = await read($, activeId)

    if (id === null) {
      return result
    }

    const endsAsking = /\?\s*$/.test(e.answer.trim())
    const status: TaskStatus = e.isAborted ? 'aborted' : e.reason === 'answer' ? (endsAsking ? 'waiting' : 'done') : 'error'
    const line = firstLine(e.answer)
    const isOwed = isSummarizing && e.answer.trim().length > 0
    const touched = await gitChanges($, e.turnId)
    const now = await $.clock.now()

    await update($, tasks, list =>
      patch(list, id, task => ({
        ...task,
        status,
        endedAt: now,
        runningSince: null,
        durationMs: task.durationMs + e.durationMs,
        result: isSummarizing && task.isSummarized ? task.result : line || task.result,
        files: [...new Set([...task.files, ...touched])],
        isReplied: false,
        pendingAnswer: isOwed ? excerpt(e.answer, 1500, 2500) : null,
      })),
    )
    await update($, activeId, current => (current === id ? null : current))
    await persist($)
    await updateStatus($)

    if (isOwed) {
      const answer = e.answer
      $.clock.after(1, () => void summarize($, id, answer, e.durationMs))
    } else {
      await notify($, id, e.durationMs)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'clear') {
      await update($, tasks, () => [])
      await update($, activeId, () => null)
      await update($, expanded, () => [])
      await persist($)
      await updateStatus($)

      return { text: 'Task history cleared.' }
    }

    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)

    if (arg === 'close' || (isUp && arg !== 'open')) {
      wantsPane = false
      await $.store.set(OPEN_KEY, false)
      await $.ui.close({ id: PANE })

      return { text: `Task history hidden. /${COMMAND} shows it again.` }
    }

    wantsPane = true
    await $.store.set(OPEN_KEY, true)
    const opened = await $.ui.open({ id: PANE, title: paneTitle() })

    return { text: opened.isPlaced ? 'Task history shown.' : `Task history is open, not drawn yet: ${opened.reason}` }
  })

  // A press on a row the row module drew: `insert:<id>` fills the prompt with the task's,
  // `point:<id>:<n>` with what takes up an open point, any other key folds.
  on('ui.message', async ($, e, next) => {
    const data: unknown = e.data
    const isPress = typeof data === 'object' && data !== null && 'press' in data && data.press === true
    const key = e.element

    if (e.requestId === PANE && isPress) {
      if (key.startsWith('insert:')) {
        await fillPrompt($, key.slice('insert:'.length))
      } else if (key.startsWith('point:')) {
        const at = key.lastIndexOf(':')
        await fillPoint($, key.slice('point:'.length, at), Number(key.slice(at + 1)))
      } else {
        await toggleRow($, key)
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.fault', ($, e, next) => {
    if (e.requestId === PANE && !faulted.has(e.surface)) {
      faulted.add(e.surface)
      $.ui.log(`task-history: rows on ${e.surface} fell back to links (${e.reason})`)
    }

    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      wantsPane = false
      await $.store.set(OPEN_KEY, false)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Opens the pane by itself only where it docks as a sidebar.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    const isFullscreen = e.viewport?.isFullscreen
    const docks = isFullscreen === true || (e.surface === 'desktop' && isFullscreen !== false)

    if (wantsPane && !hasAutoOpened && docks) {
      hasAutoOpened = true
      void $.ui.open({ id: PANE, title: paneTitle() })
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = elements
    const list = await read($, tasks)
    const open = new Set(await read($, expanded))
    await read($, tick)
    const now = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns)
    const { surface } = e

    const toggle = (key: string) => () => void toggleRow($, key)
    const insert = (task: Task) => () => void fillPrompt($, task.id)
    const takeUp = (task: Task, index: number) => () => void fillPoint($, task.id, index)
    const jumpTo = (task: Task) => () => void jump($, surface, task.id)

    // The terminal makes a whole row one Button. The desktop app's buttons
    // flicker under the pointer, plain or not, though nothing is redrawn: there
    // the row module (row.tsx) draws each row as text and posts its presses.
    // Elsewhere (VS Code draws no Client, or the module failed) a press is a link.
    const isRowButton = surface === 'terminal'
    const Client = surface === 'desktop' && 'Client' in elements && !faulted.has(surface) ? elements.Client : undefined

    const row = <T,>(key: string, parts: Part[], fallback: () => T) =>
      Client ? <Client key={key} module="./row.tsx" props={{ parts }} width="100%" /> : fallback()

    const link = (key: string, label: string, onPress: () => void, isDim = false) => {
      const href = `https://task-history.invalid/${encodeURIComponent(key)}`

      return (
        <Markdown
          key={key}
          text={`[${escapeMarkdown(label)}](${href})`}
          dimColor={isDim}
          pressableLinks={[href]}
          onLinkPress={onPress}
        />
      )
    }

    const fold = (key: string, isOpen: boolean, label: string) =>
      isRowButton ? (
        <Button key={key} plain dimColor onPress={toggle(key)}>
          {isOpen ? '▾ ' : '▸ '}
          {label}
        </Button>
      ) : (
        row(key, [{ text: `${isOpen ? '▾' : '▸'} ${label}`, isDim: true }], () =>
          link(key, `${isOpen ? '▾' : '▸'} ${label}`, toggle(key), true),
        )
      )

    // An open point: a press puts what takes it up into the prompt.
    const point = (task: Task, index: number, text: string) => {
      const key = `point:${task.id}:${index}`

      return isRowButton ? (
        <Button key={key} plain onPress={takeUp(task, index)}>
          <Text color="warning">{text}</Text>
        </Button>
      ) : (
        row(key, [{ text, color: 'warning' }], () => link(key, text, takeUp(task, index)))
      )
    }

    // Only the person's own press may scroll the conversation, and the row
    // module's presses are its code's: on desktop the jump is a link as well.
    const jumpLink = (task: Task) => {
      if (task.messageId === undefined || jumpless.has(surface)) {
        return null
      }

      const key = `jump:${task.id}`
      const label = '↑ Show in conversation'

      return isRowButton ? (
        <Button key={key} plain dimColor onPress={jumpTo(task)}>
          {label}
        </Button>
      ) : (
        link(key, label, jumpTo(task), true)
      )
    }

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No tasks yet.</Text>
          <Text dimColor>Each prompt you send shows up here with its result.</Text>
        </Box>
      )
    }

    const runningFor = (task: Task) => task.durationMs + (task.runningSince === null ? 0 : now - task.runningSince)

    // Running: how long so far. Today: how long ago. Before: the clock time, under its day.
    const when = (task: Task) => {
      if (task.status === 'running') {
        return formatDuration(runningFor(task))
      }

      if (task.isRebuilt === true) {
        return ''
      }

      return isSameDay(task.startedAt, now) ? formatAge(now - task.startedAt) : clockTime(task.startedAt)
    }

    const glance = (task: Task) => {
      if (task.status === 'running') {
        const files = task.files.length > 0 ? ` · ${task.files.length} ${task.files.length === 1 ? 'file' : 'files'}` : ''

        return (
          <Text dimColor>
            {'    '}
            {task.tools} tools{files}
          </Text>
        )
      }

      const first = task.openPoints[0]

      if (task.status === 'waiting' && first !== undefined) {
        return <Box paddingLeft={4}>{point(task, 0, cut(first, width - 4))}</Box>
      }

      // The result, one line, so the list reads without expanding.
      if (isResultLine && task.result.length > 0) {
        return <Text dimColor>{`    → ${cut(task.result, width - 6)}`}</Text>
      }

      return null
    }

    const details = (task: Task) => {
      const filesKey = `files:${task.id}`
      const promptFold = `prompt:${task.id}`
      const filesOpen = open.has(filesKey)
      const promptOpen = open.has(promptFold)
      const icon = ICONS[task.status]
      const time = task.status === 'running' ? formatDuration(runningFor(task)) : formatDuration(task.durationMs)
      const facts = [icon.word, timeSpan(task, now), time, `${task.tools} tools`].filter(fact => fact.length > 0)
      const fileCount = `${task.files.length} ${task.files.length === 1 ? 'file' : 'files'} changed`

      return (
        <Box flexDirection="column" paddingLeft={4}>
          {task.result.length > 0 && <Text>→ {task.result}</Text>}
          {(task.answered ?? []).map(answered => (
            <Text dimColor>✓ {answered}</Text>
          ))}
          {task.openPoints.map((one, index) => point(task, index, `? ${one}`))}
          <Text dimColor>{facts.join(' · ')}</Text>
          {jumpLink(task)}
          {task.files.length > 0 && fold(filesKey, filesOpen, fileCount)}
          {filesOpen && (
            <Box flexDirection="column" paddingLeft={2}>
              {task.files.map(file => (
                <Text dimColor>{cutStart(relativePath(file, cwd), width - 8)}</Text>
              ))}
            </Box>
          )}
          {fold(promptFold, promptOpen, 'Prompt')}
          {promptOpen && (
            <Box flexDirection="column" paddingLeft={2}>
              <Text>{cut(task.prompt, 2000)}</Text>
              {isRowButton ? (
                <Button key={`insert:${task.id}`} label="Insert into prompt" onPress={insert(task)} />
              ) : (
                row(`insert:${task.id}`, [{ text: '› Insert into prompt', isDim: true }], () =>
                  link(`insert:${task.id}`, 'Insert into prompt', insert(task)),
                )
              )}
            </Box>
          )}
          {task.followUps.map(followUp => (
            <Text dimColor>↳ “{cut(oneLine(followUp.text), width - 10)}”</Text>
          ))}
        </Box>
      )
    }

    const ordered = [...list].reverse()
    const days = ordered.map(task => (task.isRebuilt === true ? 'Earlier' : dayLabel(task.startedAt, now)))
    // Days are named once the list reaches back past today.
    const isDated = days.some(day => day !== 'Today')

    return (
      <Box flexDirection="column">
        {ordered.map((task, index) => {
          const isOpen = open.has(task.id)
          const icon = ICONS[task.status]
          const age = when(task)
          const day = days[index] ?? ''

          return (
            <Box flexDirection="column">
              {isDated && day !== days[index - 1] && <Text dimColor>── {day} ──</Text>}
              {isRowButton ? (
                <Button key={task.id} plain onPress={toggle(task.id)}>
                  {isOpen ? '▾ ' : '▸ '}
                  <Text color={icon.color} bold>
                    {icon.glyph}
                  </Text>
                  {` ${cut(task.title, width - age.length - 6)} `}
                  <Text dimColor>{age}</Text>
                </Button>
              ) : (
                row(
                  task.id,
                  [
                    { text: isOpen ? '▾' : '▸' },
                    { text: icon.glyph, color: icon.color, isBold: true },
                    { text: task.title, isFill: true },
                    ...(age.length > 0 ? [{ text: age, isDim: true }] : []),
                  ],
                  () => (
                    <Box flexDirection="row" gap={1}>
                      {link(task.id, isOpen ? '▾' : '▸', toggle(task.id))}
                      <Text color={icon.color} bold>
                        {icon.glyph}
                      </Text>
                      <Box flexGrow={1} flexShrink={1}>
                        <Text wrap="truncate-end">{task.title}</Text>
                      </Box>
                      {age.length > 0 && <Text dimColor>{age}</Text>}
                    </Box>
                  ),
                )
              )}
              {isOpen ? details(task) : glance(task)}
            </Box>
          )
        })}
      </Box>
    )
  })
}
