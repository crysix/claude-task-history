import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { changedPaths, parseGitStatus, relativePath } from '../hooks/logic'

const PANE = {
  plugin: 'task-history',
  component: 'Pane',
  requestId: 'task-history',
  props: {
    title: 'Tasks · proj',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

type Reply = { isFollowUp?: boolean; title: string; result: string; openPoints?: string[]; isWaitingForUser?: boolean }

type World = {
  /** What the store holds at the start. */
  store?: Record<string, unknown>
  /** What `git status --porcelain -z` prints now; left out, the folder is no repository. */
  git?: () => string
}

/** The engine beneath the mod: the calls it makes, answered from memory. */
function engine(on: On, reply: (prompt: string) => Reply | null, world: World = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const notices: { text: string; title?: string }[] = []
  const statuses: (string | undefined)[] = []
  mock.store(on, world.store)
  on('ui.notify', (_, e) => {
    notices.push({ text: e.text, title: e.title })

    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const git = world.git
    const isStatus = e.argv[1] === 'status'
    const stdout = git === undefined ? '' : isStatus ? git() : '/work/proj\n'

    return {
      value: { exitCode: git === undefined ? 128 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'history' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', (_, e) => {
    const answer = reply(e.prompt)
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

    return answer === null
      ? { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } }
      : { value: { isAnswered: true, text: JSON.stringify(answer), usage } }
  })

  return { clock, notices, statuses }
}

/** A summary prompt less the task before, the part the mock answers by. */
function request(prompt: string): string {
  return prompt.replace(/<previous>[\s\S]*<\/previous>/, '')
}

/** A press on a toggle: the Button in the terminal, the link answering it elsewhere. */
function toggleOf(surface: string, key: string) {
  return surface === 'terminal' ? { key } : { key, link: { href: `https://task-history.invalid/${encodeURIComponent(key)}` } }
}

async function turn(
  $: Engine,
  turnId: string,
  text: string,
  answer: string,
  durationMs = 1000,
) {
  await $.turn.start({ text, turnId })
  await $.turn.complete({ answer, durationMs, isAborted: false, turnId, reason: 'answer' })
}

test('a task shows its summary, open question and files on every surface', async ($, on) => {
  const { clock } = engine(on, () => ({
    title: 'Fix the login bug',
    result: 'Session check fixed in login.ts',
    openPoints: ['Add a regression test?'],
    isWaitingForUser: true,
  }))

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'please fix the login bug, users get logged out', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/proj/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: '/work/proj/src/session.ts' })
  await $.turn.complete({
    answer: 'I fixed the session check.\n\nShould I add a regression test?',
    durationMs: 72000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.advance(10)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    if (surface === 'terminal') {
      // The whole row is one press.
      expect((await ui.find({ key: 't1' }))?.text).toMatch(/\? Fix the login bug/)
    } else {
      // A chevron link is the press, the title plain text beside it.
      expect((await ui.find({ key: 't1' }))?.type).toBe('Markdown')
      expect(await ui.find({ type: 'Text', text: /Fix the login bug/ })).toBeDefined()
    }

    expect(await ui.find({ type: 'Text', text: /Add a regression test\?/ })).toBeDefined()

    await ui.press(toggleOf(surface, 't1'))
    expect(await ui.find({ type: 'Text', text: /→ Session check fixed in login\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /waiting for you · 1m12s · 2 tools/ })).toBeDefined()
    expect(await ui.find({ text: /1 file changed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/login.ts' })).toBeUndefined()

    await ui.press(toggleOf(surface, 'files:t1'))
    expect(await ui.find({ type: 'Text', text: 'src/login.ts' })).toBeDefined()

    await ui.press(toggleOf(surface, 'prompt:t1'))
    expect(await ui.find({ type: 'Text', text: /users get logged out/ })).toBeDefined()

    // Collapse again, so the next surface starts from the same place.
    await ui.press(toggleOf(surface, 'files:t1'))
    await ui.press(toggleOf(surface, 'prompt:t1'))
    await ui.press(toggleOf(surface, 't1'))
    await ui.unmount()
  }
})

test('replies and follow-ups fold into the task they continue', async ($, on) => {
  const { clock } = engine(on, prompt =>
    request(prompt).includes('FAQ')
      ? { isFollowUp: true, title: 'Translate the README', result: 'README translated, FAQ shortened' }
      : { title: 'Translate the README', result: 'README translated to English' },
  )

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Translate the README to English', 'Done: the README is in English now.')
  await clock.advance(10)
  await turn($, 't2', 'also make the FAQ shorter please', 'The FAQ is shorter now.')
  await clock.advance(10)
  await turn($, 't3', 'ok danke', 'You are welcome.')
  await clock.advance(10)
  await turn($, 't4', 'Update composer dependencies', 'Updated 3 packages.')
  await clock.advance(10)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = (await ui.findAll({ type: surface === 'terminal' ? 'Button' : 'Markdown' })).map(row => row.key)

    expect(rows).toEqual(['t4', 't1'])

    await ui.press(toggleOf(surface, 't1'))
    expect(await ui.find({ text: /Translate the README/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /README translated, FAQ shortened/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ “also make the FAQ shorter please”/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ “ok danke”/ })).toBeDefined()

    await ui.press(toggleOf(surface, 't1'))
    await ui.unmount()
  }
})

test('without a summary the raw prompt and reply stay', async ($, on) => {
  const { clock } = engine(on, () => null)

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Refactor the payment service into smaller modules', '## Done\nSplit it into three modules.')
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ key: 't1' }))?.text).toMatch(/✓ Refactor the payment service/)
  await ui.press({ key: 't1' })
  expect(await ui.find({ type: 'Text', text: /→ Done/ })).toBeDefined()
  await ui.unmount()
})

test('/history clear empties the list', async ($, on) => {
  engine(on, () => null)

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Write a changelog entry', 'Added the entry.')

  const result = await $.command.run({
    command: 'history',
    args: 'clear',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(result.text).toBe('Task history cleared.')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No tasks yet/ })).toBeDefined()
  await ui.unmount()
})

test('files changed by shell commands are found through git', async ($, on) => {
  let status = ' M README.md\0'
  const { clock } = engine(on, () => null, { git: () => status })

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Generate the deploy script', turnId: 't1' })
  status = ' M README.md\0?? scripts/deploy.sh\0R  docs/new.md\0docs/old.md\0'
  await $.turn.complete({ answer: 'Wrote scripts/deploy.sh.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 't1' })
  expect((await ui.find({ key: 'files:t1' }))?.text).toMatch(/2 files changed/)
  await ui.press({ key: 'files:t1' })
  expect(await ui.find({ type: 'Text', text: 'scripts/deploy.sh' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'docs/new.md' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'README.md' })).toBeUndefined()
  await ui.unmount()
})

test('a long task that waits raises a notification, a short one none', async ($, on) => {
  const { clock, notices } = engine(on, () => ({
    title: 'Fix the login bug',
    result: 'Fixed',
    openPoints: ['Add a regression test?'],
    isWaitingForUser: true,
  }))

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Fix the login bug', 'Fixed. Add a regression test?', 45000)
  await clock.advance(10)
  expect(notices).toEqual([{ text: '? Add a regression test?', title: 'Claude · proj' }])

  await turn($, 't2', 'Explain the session check', 'It compares the token. Anything else?', 3000)
  await clock.advance(10)
  expect(notices).toHaveLength(1)
})

test('the status line shows the running task and clears once it is done', async ($, on) => {
  const { clock, statuses } = engine(on, () => ({ title: 'Write the changelog', result: 'Added' }))

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Write the changelog entry', turnId: 't1' })
  expect(statuses.at(-1)).toBe('⟳ Write the changelog entry · 0s')

  await $.turn.complete({ answer: 'Added the entry.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  expect(statuses.at(-1)).toBeUndefined()
})

test('a summary a reload cut off is asked for again at the next start', async ($, on) => {
  const owed = {
    id: 'old-1',
    prompt: 'please update the readme',
    title: 'please update the readme',
    result: 'I updated the README.',
    openPoints: [],
    status: 'done',
    startedAt: 999_000,
    runningSince: null,
    durationMs: 5000,
    tools: 2,
    files: [],
    followUps: [],
    isSummarized: false,
    needsGrouping: false,
    pendingAnswer: 'I updated the README.',
  }
  const { clock } = engine(on, () => ({ title: 'Update the README', result: 'README updated' }), {
    store: { sessions: ['session-1'], 'session:session-1': [owed] },
  })

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'old-1' }))?.text).toMatch(/✓ Update the README/)
  await ui.unmount()
})

test('a task merged into one with no summary takes the new title', async ($, on) => {
  let calls = 0
  const { clock } = engine(on, () => {
    calls += 1

    return calls === 1 ? null : { isFollowUp: true, title: 'Translate and trim the README', result: 'Translated, FAQ trimmed' }
  })

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Translate the README to English', 'Done.')
  await clock.advance(10)
  await turn($, 't2', 'also make the FAQ shorter please', 'Shorter now.')
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Button' })).map(row => row.key)).toEqual(['t1'])
  expect((await ui.find({ key: 't1' }))?.text).toMatch(/Translate and trim the README/)
  await ui.unmount()
})

test('paths and git readings on Windows and POSIX', async () => {
  expect(relativePath('C:\\Users\\me\\proj\\src\\a.ts', 'C:\\Users\\Me\\proj')).toBe('src/a.ts')
  expect(relativePath('/work/proj/src/a.ts', '/work/proj/')).toBe('src/a.ts')
  expect(relativePath('/elsewhere/a.ts', '/work/proj')).toBe('/elsewhere/a.ts')

  const before = parseGitStatus(' M a.ts\0?? b.ts\0')
  const after = parseGitStatus('MM a.ts\0?? b.ts\0R  c.ts\0old.ts\0')
  expect([...after.keys()]).toEqual(['a.ts', 'b.ts', 'c.ts'])
  expect(changedPaths(before, after)).toEqual(['a.ts', 'c.ts'])
})

test('/history debug counts the drawings of the pane', async ($, on) => {
  engine(on, () => null)

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Write a changelog entry', 'Added the entry.')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press(toggleOf('desktop', 't1'))
  await ui.unmount()

  const result = await $.command.run({
    command: 'history',
    args: 'debug',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(result.text).toMatch(/Pane drawn [2-9]\d* times since load/)
  expect(result.text).toMatch(/Last drawing: desktop, dock, focused false, 44 columns/)
})
