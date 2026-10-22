export type TaskStatus = 'running' | 'done' | 'waiting' | 'aborted' | 'error'

export type FollowUp = { text: string; at: number }

export type Task = {
  /** The id of the turn that started the task. */
  id: string
  /** The prompt as the person typed it (cut to a few thousand characters). */
  prompt: string
  /** A short title: the summary's, or the prompt's opening words until then. */
  title: string
  /** One line on what came of it: the summary's, or the reply's first line. */
  result: string
  /** Questions or next steps the last reply left to the person. */
  openPoints: string[]
  status: TaskStatus
  startedAt: number
  /** When the turn running now began; null while no turn runs on the task. */
  runningSince: number | null
  /** The finished turns' time, summed. */
  durationMs: number
  tools: number
  /** Absolute paths of the files Edit, Write and NotebookEdit changed. */
  files: string[]
  /** Short replies and corrections the person gave on this task. */
  followUps: FollowUp[]
  isSummarized: boolean
  /** True until the summary has said whether the task merely continues the one before. */
  needsGrouping: boolean
  /** The reply a summary is still owed for, kept so a reload can catch up; null once done. */
  pendingAnswer?: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'task-history': {
      tasks: Task[]
      /** The task whose turn runs now. */
      activeId: string | null
      /** The session the tasks belong to. */
      sessionId: string
      /** Keys of the expanded rows: a task id, or `files:<id>` / `prompt:<id>`. */
      expanded: string[]
      /** Bumped by a timer so ages and running times stay fresh. */
      tick: number
    }
  }
}
