import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Task, TaskStatus } from '../types'
import type { NotifyLevel } from './logic'
import {
  addTask,
  applySummary,
  changedPaths,
  cut,
  excerpt,
  firstLine,
  formatAge,
  formatDuration,
  isAck,
  newTask,
  normalize,
  notification,
  oneLine,
  parseGitStatus,
  patch,
  parseSummary,
  projectName,
  relativePath,
  statusText,
  SUMMARY_SYSTEM,
  summaryPrompt,
  tasksFromMessages,
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
// For `/history debug`: when the pane was drawn, with what, and what moved its focus.
const drawnAt: number[] = []
let lastDrawing = ''
const focusMoves: string[] = []
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
  const known = Array.isArray(stored) ? stored.filter((one): one is string => typeof one === 'string') : []

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

async function resumeTask($: Engine, id: string, now: number) {
  await update($, tasks, list =>
    patch(list, id, task => ({ ...task, status: 'running', runningSince: now })),
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
  const text = task === undefined ? undefined : notification(task, notifyLevel)

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

    if (folded.delete(typed) || typed === '' || matched?.isPrompt === false) {
      if (last !== undefined) {
        await resumeTask($, last.id, now)
      }
    } else if (last !== undefined && isAck(text)) {
      await addFollowUp($, last.id, text, now)
      await resumeTask($, last.id, now)
    } else {
      const task = newTask(e.turnId, text, now, last !== undefined)
      await update($, tasks, list => addTask(list, task))
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

    await update($, tasks, list =>
      patch(list, id, task => ({
        ...task,
        status,
        runningSince: null,
        durationMs: task.durationMs + e.durationMs,
        result: isSummarizing && task.isSummarized ? task.result : line || task.result,
        files: [...new Set([...task.files, ...touched])],
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

    if (arg === 'debug') {
      const now = await $.clock.now()
      const recent = drawnAt.filter(at => now - at < 10000).length

      return {
        text: [
          `Pane drawn ${drawnAt.length} times since load, ${recent} in the last 10 s.`,
          `Last drawing: ${lastDrawing || 'none'}`,
          `Focus moves (${focusMoves.length}): ${focusMoves.slice(-8).join(', ') || 'none'}`,
        ].join('\n'),
      }
    }

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

  on('ui.focus', { requestId: PANE }, ($, e, next) => {
    focusMoves.push(`${e.element ?? 'engine mark'} by ${e.origin.kind}`)

    if (focusMoves.length > 50) {
      focusMoves.shift()
    }

    return next(e)
  }).catch(($, e, next) => next(e))

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
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, tasks)
    const open = new Set(await read($, expanded))
    await read($, tick)
    const now = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns)
    const { scroll } = e.props

    drawnAt.push(now)

    if (drawnAt.length > 500) {
      drawnAt.shift()
    }

    lastDrawing =
      `${e.surface}, ${e.props.placement}, focused ${e.props.isFocused}, ` +
      `${e.props.bodyColumns} columns, ${scroll.bodyRows} rows, offset ${scroll.offset}`

    const toggle = (key: string) => () =>
      void update($, expanded, keys => (keys.includes(key) ? keys.filter(one => one !== key) : [...keys, key]))

    // The terminal makes a whole row one press. Elsewhere a Button is a native
    // button, which reflowed a full row under the pointer on hover (flicker):
    // there only a chevron is pressable, beside plain text.
    const isRowButton = e.surface === 'terminal'

    const fold = (key: string, isOpen: boolean, label: string) =>
      isRowButton ? (
        <Button key={key} plain dimColor onPress={toggle(key)}>
          {isOpen ? '▾ ' : '▸ '}
          {label}
        </Button>
      ) : (
        <Box flexDirection="row" gap={1}>
          <Button key={key} plain dimColor label={isOpen ? '▾' : '▸'} onPress={toggle(key)} />
          <Text dimColor>{label}</Text>
        </Box>
      )

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No tasks yet.</Text>
          <Text dimColor>Each prompt you send shows up here with its result.</Text>
        </Box>
      )
    }

    const runningFor = (task: Task) => task.durationMs + (task.runningSince === null ? 0 : now - task.runningSince)

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

      const point = task.openPoints[0]

      if (task.status === 'waiting' && point !== undefined) {
        return <Text color="warning">{`    ${cut(point, width - 4)}`}</Text>
      }

      return null
    }

    const details = (task: Task) => {
      const filesKey = `files:${task.id}`
      const promptKey = `prompt:${task.id}`
      const filesOpen = open.has(filesKey)
      const promptOpen = open.has(promptKey)
      const icon = ICONS[task.status]
      const time = task.status === 'running' ? formatDuration(runningFor(task)) : formatDuration(task.durationMs)
      const fileCount = `${task.files.length} ${task.files.length === 1 ? 'file' : 'files'} changed`

      return (
        <Box flexDirection="column" paddingLeft={4}>
          {task.result.length > 0 && <Text>→ {task.result}</Text>}
          {task.openPoints.map(point => (
            <Text color="warning">? {point}</Text>
          ))}
          <Text dimColor>
            {icon.word} · {time} · {task.tools} tools
          </Text>
          {task.files.length > 0 && fold(filesKey, filesOpen, fileCount)}
          {filesOpen && (
            <Box flexDirection="column" paddingLeft={2}>
              {task.files.map(file => (
                <Text dimColor>{cutStart(relativePath(file, cwd), width - 8)}</Text>
              ))}
            </Box>
          )}
          {fold(promptKey, promptOpen, 'Prompt')}
          {promptOpen && (
            <Box flexDirection="column" paddingLeft={2}>
              <Text>{cut(task.prompt, 2000)}</Text>
              <Button
                key={`insert:${task.id}`}
                label="Insert into prompt"
                onPress={() => void $.prompt.fill({ text: task.prompt })}
              />
            </Box>
          )}
          {task.followUps.map(followUp => (
            <Text dimColor>↳ “{cut(oneLine(followUp.text), width - 10)}”</Text>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {[...list].reverse().map(task => {
          const isOpen = open.has(task.id)
          const icon = ICONS[task.status]
          const when = task.status === 'running' ? formatDuration(runningFor(task)) : formatAge(now - task.startedAt)

          return (
            <Box flexDirection="column">
              {isRowButton ? (
                <Button key={task.id} plain onPress={toggle(task.id)}>
                  {isOpen ? '▾ ' : '▸ '}
                  <Text color={icon.color} bold>
                    {icon.glyph}
                  </Text>
                  {` ${cut(task.title, width - when.length - 6)} `}
                  <Text dimColor>{when}</Text>
                </Button>
              ) : (
                <Box flexDirection="row" gap={1}>
                  <Button key={task.id} plain label={isOpen ? '▾' : '▸'} onPress={toggle(task.id)} />
                  <Text color={icon.color} bold>
                    {icon.glyph}
                  </Text>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate-end">{task.title}</Text>
                  </Box>
                  <Text dimColor>{when}</Text>
                </Box>
              )}
              {isOpen ? details(task) : glance(task)}
            </Box>
          )
        })}
      </Box>
    )
  })
}
