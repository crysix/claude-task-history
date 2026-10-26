import type { SessionMessage } from 'claude-code'

import type { Task, TaskStatus } from '../types'

export const MAX_TASKS = 100
const MAX_PROMPT = 4000
const MAX_ANSWERED = 6

/** Replies that only answer or confirm the task before: never a task of their own. */
const ACKS = new Set([
  'ja', 'jo', 'jep', 'jup', 'yes', 'y', 'yep', 'yeah', 'sure', 'ok', 'okay', 'oki', 'k',
  'nein', 'no', 'n', 'nope', 'passt', 'gut', 'super', 'perfekt', 'perfect', 'great',
  'danke', 'thanks', 'thx', 'weiter', 'mach', 'machs', 'mach\'s', 'das', 'so', 'bitte',
  'continue', 'go', 'ahead', 'los', 'leg', 'do', 'it', 'klar', 'genau', 'top', 'fine',
  'sounds', 'good', 'schön', 'cool', 'nice', 'alles', 'richtig', 'right', 'correct',
])

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function cut(text: string, length: number): string {
  if (length < 2) {
    return text.slice(0, Math.max(0, length))
  }

  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

/** The key two spellings of one prompt share. */
export function normalize(text: string): string {
  return oneLine(text).toLowerCase()
}

/** The key a task and the transcript row of its prompt share, short enough to compare often. */
export function promptKey(text: string): string {
  return normalize(text).slice(0, 300)
}

/** Text shown as a markdown link's label, its marks taken literally. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\[\]*_`<>]/g, mark => `\\${mark}`)
}

export function fallbackTitle(prompt: string): string {
  return cut(oneLine(prompt), 60) || '(empty prompt)'
}

/** The first line of a reply that says something, markdown marks stripped. */
export function firstLine(answer: string): string {
  const line = answer
    .split('\n')
    .map(row => row.replace(/^[\s#>*\-+|`]+/, '').replace(/[*_`]+/g, '').trim())
    .find(row => row.length > 0)

  return cut(line ?? '', 160)
}

/** "ja", "ok, mach weiter", "B": a reply that only continues the task before. */
export function isAck(prompt: string): boolean {
  const text = normalize(prompt).replace(/[^\p{L}\p{N}'\s]/gu, ' ').trim()

  if (text.length === 0) {
    return false
  }

  const words = text.split(/\s+/)

  return text.length <= 3 || (words.length <= 4 && words.every(word => ACKS.has(word)))
}

export function newTask(id: string, prompt: string, now: number, needsGrouping: boolean): Task {
  return {
    id,
    prompt: prompt.slice(0, MAX_PROMPT),
    title: fallbackTitle(prompt),
    result: '',
    openPoints: [],
    openPrompts: [],
    answered: [],
    isReplied: false,
    status: 'running',
    startedAt: now,
    runningSince: now,
    durationMs: 0,
    tools: 0,
    files: [],
    followUps: [],
    isSummarized: false,
    needsGrouping,
    pendingAnswer: null,
  }
}

export function addTask(list: readonly Task[], task: Task): Task[] {
  return [...list, task].slice(-MAX_TASKS)
}

export function patch(list: readonly Task[], id: string, change: (task: Task) => Task): Task[] {
  return list.map(task => (task.id === id ? change(task) : task))
}

function addAnswered(answered: readonly string[] | undefined, points: readonly string[]): string[] {
  return [...new Set([...(answered ?? []), ...points])].slice(-MAX_ANSWERED)
}

/** The person replied to the task: the questions it waited on count as answered. */
export function markReplied(task: Task): Task {
  if (task.status !== 'waiting') {
    return { ...task, isReplied: true }
  }

  return {
    ...task,
    status: 'done',
    openPoints: [],
    openPrompts: [],
    answered: addAnswered(task.answered, task.openPoints),
    isReplied: true,
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)

  if (minutes < 10) {
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** How long ago, as compact as the row allows: "now", "12m", "3h", "2d". */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000)

  if (minutes < 1) {
    return 'now'
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The local time of day, "14:32". */
export function clockTime(ms: number): string {
  const date = new Date(ms)

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function startOfDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)

  return date.getTime()
}

export function isSameDay(one: number, other: number): boolean {
  return startOfDay(one) === startOfDay(other)
}

/** The local day a time falls on, as a list heads it: "Today", "Yesterday", "Fri 24 Oct". */
export function dayLabel(ms: number, now: number): string {
  // Rounded, since a day that changes the clock is an hour short or long.
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86400000)

  if (days <= 0) {
    return 'Today'
  }

  if (days === 1) {
    return 'Yesterday'
  }

  const date = new Date(ms)
  const year = date.getFullYear() === new Date(now).getFullYear() ? '' : ` ${date.getFullYear()}`

  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}${year}`
}

/** When a task ran by the clock: "14:32", "14:32–14:36", the end's day named when it is another. */
export function timeSpan(task: Task, now: number): string {
  if (task.isRebuilt === true) {
    return ''
  }

  const start = clockTime(task.startedAt)
  const end = task.status === 'running' || task.endedAt === undefined ? undefined : task.endedAt

  if (end === undefined) {
    return start
  }

  if (!isSameDay(task.startedAt, end)) {
    return `${start}–${dayLabel(end, now)} ${clockTime(end)}`
  }

  return clockTime(end) === start ? start : `${start}–${clockTime(end)}`
}

/** A path below `cwd` as relative, on Windows (`C:\x\y`) as on POSIX; any other as it is. */
export function relativePath(path: string, cwd: string): string {
  const file = path.replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const isWindows = /^[a-z]:\//i.test(base)
  const isBelow = isWindows
    ? file.toLowerCase().startsWith(`${base.toLowerCase()}/`)
    : file.startsWith(`${base}/`)

  return isBelow ? file.slice(base.length + 1) : file
}

export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd
}

export type Summary = {
  isFollowUp: boolean
  title: string
  result: string
  openPoints: string[]
  /** What the person would send to take up each open point; '' where the model gave none. */
  openPrompts: string[]
  isWaitingForUser: boolean
}

export const SUMMARY_SYSTEM =
  'You summarize the tasks a person gives a coding assistant, for a compact task list. ' +
  'Reply with one JSON object and nothing else.'

/** Keeps a long text's head and tail, where a request and a reply say the most. */
export function excerpt(text: string, head: number, tail: number): string {
  return text.length <= head + tail ? text : `${text.slice(0, head)}\n[…]\n${text.slice(-tail)}`
}

export function summaryPrompt(task: Task, answer: string, previous: Task | undefined): string {
  const parts: string[] = []

  if (previous !== undefined) {
    const asked = [...(previous.answered ?? []), ...previous.openPoints].slice(-3)
    const points = asked.length > 0 ? `\nasked or proposed to the person: ${asked.join(' | ')}` : ''

    parts.push(
      `The task before this one:\n<previous>\ntitle: ${previous.title}\nresult: ${previous.result}${points}\n</previous>`,
    )
  }

  parts.push(`The person's request:\n<request>\n${excerpt(task.prompt, 2500, 500)}\n</request>`)

  if (task.followUps.length > 0) {
    const replies = task.followUps.map(one => `- ${cut(oneLine(one.text), 300)}`).join('\n')
    parts.push(`What the person said on this task afterwards, in order:\n<followups>\n${replies}\n</followups>`)
  }

  if (task.result) {
    parts.push(`The result of this task so far: ${task.result}`)
  }

  parts.push(`The assistant's latest reply:\n<reply>\n${excerpt(answer, 1500, 2500)}\n</reply>`)

  const fields = [
    previous !== undefined
      ? '- "isFollowUp": true only when the request answers a question of the task before or takes up what it ' +
        'proposed, confirms, corrects or refines its result, or asks to go on with it; false when it asks for a ' +
        'different result or action the task before did not propose, even on the same project (a release after a ' +
        'license, tests after a fix)'
      : '- "isFollowUp": false',
    '- "title": the whole task in at most 6 words, no trailing period',
    '- "result": what the whole task achieved so far, in at most 20 words, keeping what the result so far says ' +
      'unless the latest reply changes it; if nothing was done yet, what the assistant waits for',
    '- "openPoints": up to 3 questions or proposed next steps the reply leaves to the person, else []; each an ' +
      'object with "text", the point in a few words, and "prompt", what the person would send to take it up, ' +
      'as an instruction to the assistant (for "Add a regression test?": "Yes, add a regression test for the ' +
      'session check")',
    '- "isWaitingForUser": true when the reply ends by asking the person a question or for a decision',
  ]

  parts.push(
    `Return a JSON object with these fields:\n${fields.join('\n')}\n` +
      'Write title, result and openPoints in the language of the request.',
  )

  return parts.join('\n\n')
}

export function parseSummary(text: string): Summary | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')

  if (start < 0 || end <= start) {
    return undefined
  }

  try {
    const raw: unknown = JSON.parse(text.slice(start, end + 1))

    if (typeof raw !== 'object' || raw === null) {
      return undefined
    }

    const value = raw as Record<string, unknown>
    const title = typeof value.title === 'string' ? oneLine(value.title) : ''

    if (title.length === 0) {
      return undefined
    }

    // A point is `{ text, prompt }`; a plain string, as models answered before, stands for its text.
    const points = (Array.isArray(value.openPoints) ? value.openPoints : [])
      .map((point: unknown) => {
        const item = typeof point === 'object' && point !== null ? (point as Record<string, unknown>) : { text: point }

        return {
          text: typeof item.text === 'string' ? oneLine(item.text) : '',
          prompt: typeof item.prompt === 'string' ? oneLine(item.prompt) : '',
        }
      })
      .filter(point => point.text.length > 0)
      .slice(0, 3)

    return {
      isFollowUp: value.isFollowUp === true,
      title: cut(title, 80),
      result: typeof value.result === 'string' ? cut(oneLine(value.result), 240) : '',
      openPoints: points.map(point => cut(point.text, 200)),
      openPrompts: points.map(point => cut(point.prompt, 500)),
      isWaitingForUser: value.isWaitingForUser === true,
    }
  } catch {
    return undefined
  }
}

function settledStatus(status: TaskStatus, isWaiting: boolean): TaskStatus {
  if (status === 'done' || status === 'waiting') {
    return isWaiting ? 'waiting' : 'done'
  }

  return status
}

type Settled = { status: TaskStatus; openPoints: string[]; openPrompts: string[]; answered: string[] }

/** A summary's points and status for its task; questions the person replied to before it came are answered. */
function settle(task: Task, summary: Summary): Settled {
  const isAnswered = summary.isWaitingForUser && task.isReplied === true

  return {
    status: settledStatus(task.status, summary.isWaitingForUser && !isAnswered),
    openPoints: isAnswered ? [] : summary.openPoints,
    openPrompts: isAnswered ? [] : summary.openPrompts,
    answered: isAnswered ? summary.openPoints : [],
  }
}

/**
 * Puts a summary on its task. A task the summary calls a follow-up is folded
 * into the one before it: its prompt becomes a follow-up there, its time,
 * tools and files add up, and the summary speaks for the whole.
 */
export function applySummary(
  list: readonly Task[],
  id: string,
  summary: Summary,
): { tasks: Task[]; mergedInto?: string } {
  const index = list.findIndex(task => task.id === id)
  const task = list[index]

  if (task === undefined) {
    return { tasks: [...list] }
  }

  const previous = index > 0 ? list[index - 1] : undefined
  const settled = settle(task, summary)

  if (task.needsGrouping && summary.isFollowUp && previous !== undefined) {
    const merged: Task = {
      ...previous,
      title: previous.isSummarized ? previous.title : summary.title,
      pendingAnswer: null,
      followUps: [...previous.followUps, { text: task.prompt, at: task.startedAt }, ...task.followUps],
      durationMs: previous.durationMs + task.durationMs,
      tools: previous.tools + task.tools,
      files: [...new Set([...previous.files, ...task.files])],
      status: settled.status,
      runningSince: task.runningSince,
      result: summary.result || previous.result,
      openPoints: settled.openPoints,
      openPrompts: settled.openPrompts,
      endedAt: task.endedAt ?? previous.endedAt,
      answered: addAnswered(previous.answered, [...(task.answered ?? []), ...settled.answered]),
      isReplied: task.isReplied,
      isSummarized: true,
    }

    return {
      tasks: list.filter(one => one.id !== id).map(one => (one.id === previous.id ? merged : one)),
      mergedInto: previous.id,
    }
  }

  return {
    tasks: patch(list, id, one => ({
      ...one,
      title: summary.title,
      result: summary.result || one.result,
      openPoints: settled.openPoints,
      openPrompts: settled.openPrompts,
      answered: addAnswered(one.answered, settled.answered),
      status: settled.status,
      isSummarized: true,
      needsGrouping: false,
      pendingAnswer: null,
    })),
  }
}

/** True for a user row the person typed, not a tool result or an injected block. */
function isTypedPrompt(message: SessionMessage): boolean {
  const text = message.text.trim()

  return (
    message.role === 'user' &&
    (message.toolResults ?? []).length === 0 &&
    text.length > 0 &&
    !text.startsWith('<') &&
    !text.startsWith('[Request interrupted')
  )
}

/**
 * The task list of a transcript the mod did not watch (a session resumed
 * from before the mod was on): raw titles and results, no summaries.
 */
export function tasksFromMessages(messages: readonly SessionMessage[], now: number): Task[] {
  const tasks: Task[] = []
  let current: Task | undefined
  let answer = ''

  const close = () => {
    if (current !== undefined) {
      current.result = firstLine(answer)
      current.status = 'done'
      current.runningSince = null
    }
  }

  messages.forEach((message, index) => {
    if (isTypedPrompt(message)) {
      if (current !== undefined && isAck(message.text)) {
        current.followUps.push({ text: message.text, at: now })

        return
      }

      close()
      current = { ...newTask(`transcript-${index}`, message.text, now, false), isRebuilt: true }
      tasks.push(current)
      answer = ''

      return
    }

    if (message.role === 'assistant' && current !== undefined) {
      current.tools += message.toolUses.length

      for (const use of message.toolUses) {
        const path = use.input.file_path ?? use.input.notebook_path
        const isEdit = use.tool === 'Edit' || use.tool === 'Write' || use.tool === 'NotebookEdit'

        if (isEdit && typeof path === 'string' && !current.files.includes(path)) {
          current.files.push(path)
        }
      }

      if (message.text.trim()) {
        answer = message.text
      }
    }
  })

  close()

  return tasks.slice(-MAX_TASKS)
}

/** `git status --porcelain=v1 -z` as path to its two-letter code; a rename's old path is skipped. */
export function parseGitStatus(stdout: string): Map<string, string> {
  const entries = new Map<string, string>()
  const fields = stdout.split('\0')

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? ''

    if (field.length < 4) {
      continue
    }

    const code = field.slice(0, 2)
    entries.set(field.slice(3), code)

    if (code.includes('R') || code.includes('C')) {
      index += 1
    }
  }

  return entries
}

/** The paths whose state differs between two `git status` readings: what the turn touched. */
export function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const changed = [...after].filter(([path, code]) => before.get(path) !== code).map(([path]) => path)
  const reverted = [...before.keys()].filter(path => !after.has(path))

  return [...changed, ...reverted]
}

export type NotifyLevel = 'all' | 'waiting' | 'off'

/** The text of the notification a finished task raises, or undefined for none. */
export function notification(task: Task, level: NotifyLevel): string | undefined {
  if (level === 'off' || task.status === 'running' || task.status === 'aborted') {
    return undefined
  }

  if (task.status === 'waiting') {
    return `? ${task.openPoints[0] ?? task.title}`
  }

  if (level !== 'all') {
    return undefined
  }

  return task.status === 'error' ? `✗ ${task.title}: failed` : `✓ ${task.title}${task.result ? ` – ${task.result}` : ''}`
}

/** The status line entry for the task in front: running or waiting; undefined clears it. */
export function statusText(task: Task | undefined, now: number): string | undefined {
  if (task?.status === 'running') {
    const elapsed = task.durationMs + (task.runningSince === null ? 0 : now - task.runningSince)

    return `⟳ ${cut(task.title, 40)} · ${formatDuration(elapsed)}`
  }

  if (task?.status === 'waiting') {
    return `? ${cut(task.title, 40)}`
  }

  return undefined
}
