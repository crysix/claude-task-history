import type { SessionMessage } from 'claude-code'

import type { Task, TaskStatus } from '../types'

export const MAX_TASKS = 100
const MAX_PROMPT = 4000

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
    status: 'running',
    startedAt: now,
    runningSince: now,
    durationMs: 0,
    tools: 0,
    files: [],
    followUps: [],
    isSummarized: false,
    needsGrouping,
  }
}

export function addTask(list: readonly Task[], task: Task): Task[] {
  return [...list, task].slice(-MAX_TASKS)
}

export function patch(list: readonly Task[], id: string, change: (task: Task) => Task): Task[] {
  return list.map(task => (task.id === id ? change(task) : task))
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

export function relativePath(path: string, cwd: string): string {
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`

  return path.startsWith(root) ? path.slice(root.length) : path
}

export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd
}

export type Summary = {
  isFollowUp: boolean
  title: string
  result: string
  openPoints: string[]
  isWaitingForUser: boolean
}

export const SUMMARY_SYSTEM =
  'You summarize the tasks a person gives a coding assistant, for a compact task list. ' +
  'Reply with one JSON object and nothing else.'

/** Keeps a long text's head and tail, where a request and a reply say the most. */
function excerpt(text: string, head: number, tail: number): string {
  return text.length <= head + tail ? text : `${text.slice(0, head)}\n[…]\n${text.slice(-tail)}`
}

export function summaryPrompt(task: Task, answer: string, previous: Task | undefined): string {
  const parts: string[] = []

  if (previous !== undefined) {
    parts.push(
      `The task before this one:\n<previous>\ntitle: ${previous.title}\nresult: ${previous.result}\n</previous>`,
    )
  }

  parts.push(`The person's request:\n<request>\n${excerpt(task.prompt, 2500, 500)}\n</request>`)

  if (task.followUps.length > 0) {
    const replies = task.followUps.map(one => `- ${cut(oneLine(one.text), 300)}`).join('\n')
    parts.push(`What the person said on this task afterwards, in order:\n<followups>\n${replies}\n</followups>`)
  }

  if (task.isSummarized && task.result) {
    parts.push(`The result so far: ${task.result}`)
  }

  parts.push(`The assistant's latest reply:\n<reply>\n${excerpt(answer, 1500, 2500)}\n</reply>`)

  const fields = [
    previous !== undefined
      ? '- "isFollowUp": true when the request only continues, answers, confirms or corrects the task before instead of starting a new one'
      : '- "isFollowUp": false',
    '- "title": the whole task in at most 6 words, no trailing period',
    '- "result": what was done or found so far, in at most 20 words; if nothing was done yet, what the assistant waits for',
    '- "openPoints": up to 3 short questions or proposed next steps the reply leaves to the person, else []',
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

    const points = Array.isArray(value.openPoints) ? value.openPoints : []

    return {
      isFollowUp: value.isFollowUp === true,
      title: cut(title, 80),
      result: typeof value.result === 'string' ? cut(oneLine(value.result), 240) : '',
      openPoints: points
        .filter((point): point is string => typeof point === 'string' && point.trim().length > 0)
        .slice(0, 3)
        .map(point => cut(oneLine(point), 200)),
      isWaitingForUser: value.isWaitingForUser === true,
    }
  } catch {
    return undefined
  }
}

function settledStatus(status: TaskStatus, summary: Summary): TaskStatus {
  if (status === 'done' || status === 'waiting') {
    return summary.isWaitingForUser ? 'waiting' : 'done'
  }

  return status
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

  if (task.needsGrouping && summary.isFollowUp && previous !== undefined) {
    const merged: Task = {
      ...previous,
      followUps: [...previous.followUps, { text: task.prompt, at: task.startedAt }, ...task.followUps],
      durationMs: previous.durationMs + task.durationMs,
      tools: previous.tools + task.tools,
      files: [...new Set([...previous.files, ...task.files])],
      status: settledStatus(task.status, summary),
      runningSince: task.runningSince,
      result: summary.result || previous.result,
      openPoints: summary.openPoints,
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
      openPoints: summary.openPoints,
      status: settledStatus(one.status, summary),
      isSummarized: true,
      needsGrouping: false,
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
      current = newTask(`transcript-${index}`, message.text, now, false)
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
