import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On, SessionAppendInput, SessionMessage } from 'claude-code'

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

const SURFACES = ['terminal', 'desktop', 'vscode'] as const

/** What a press on a row is on each surface: a Button, a row module's click, an answered link. */
const ROWS = { terminal: 'Button', desktop: 'Client', vscode: 'Markdown' } as const

type Point = string | { text: string; prompt: string }

type Reply = { isFollowUp?: boolean; title: string; result: string; openPoints?: Point[]; isWaitingForUser?: boolean }

type World = {
  /** What the store holds at the start. */
  store?: Record<string, unknown>
  /** What `git status --porcelain -z` prints now; left out, the folder is no repository. */
  git?: () => string
  /** The clock at the start; left out, a moment early on 1 January 1970. */
  now?: number
  /** The transcript `$.session.messages()` reads; left out, none. */
  messages?: SessionMessage[]
}

/** The engine beneath the mod: the calls it makes, answered from memory. */
function engine(on: On, reply: (prompt: string) => Reply | null, world: World = {}) {
  const clock = mock.clock(on, { now: world.now ?? 1_000_000 })
  const notices: { text: string; title?: string }[] = []
  const statuses: (string | undefined)[] = []
  const fills: string[] = []
  const toasts: string[] = []
  // The store by hand, so a test can read what the mod kept.
  const store = new Map(Object.entries(world.store ?? {}))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
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
  on('prompt.fill', (_, e) => {
    fills.push(e.text)

    return { isFilled: true }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.messages', () => ({ value: world.messages ?? [] }))
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

  return { clock, notices, statuses, fills, toasts, store }
}

/** The transcript row a prompt the person typed is kept as. */
function promptRow(uuid: string, text: string): SessionAppendInput {
  return {
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid,
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
  }
}

/** Presses a link the pane drew as Markdown: in VS Code every press, on desktop the jump to the conversation. */
async function pressLink<S extends (typeof SURFACES)[number]>(ui: Mounted<S, 'Pane'>, key: string) {
  await ui.press({ key, link: { href: `https://task-history.invalid/${encodeURIComponent(key)}` } })
}

/** A summary prompt less the task before, the part the mock answers by. */
function request(prompt: string): string {
  return prompt.replace(/<previous>[\s\S]*<\/previous>/, '')
}

/** Presses a row: its Button in the terminal, a click on the row module on desktop, its link in VS Code. */
async function pressRow(ui: Mounted<(typeof SURFACES)[number], 'Pane'>, surface: (typeof SURFACES)[number], key: string) {
  if (surface === 'desktop') {
    // Mounted over all three surfaces holds only their common acts; this one is desktop's.
    const desktop = ui as unknown as Mounted<'desktop', 'Pane'>
    await desktop.pointer({ type: 'down', x: 3, y: 0, button: 'left', in: key })
  } else if (surface === 'vscode') {
    await ui.press({ key, link: { href: `https://task-history.invalid/${encodeURIComponent(key)}` } })
  } else {
    await ui.press({ key })
  }
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
  const { clock, fills } = engine(on, () => ({
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

    expect((await ui.find({ key: 't1' }))?.type).toBe(ROWS[surface])

    if (surface === 'terminal') {
      // The whole row is one press.
      expect((await ui.find({ key: 't1' }))?.text).toMatch(/\? Fix the login bug/)
    } else if (surface === 'desktop') {
      // The row module draws the whole row; a click anywhere on it presses.
      expect(await ui.find({ in: 't1', type: 'Text', text: /Fix the login bug/ })).toBeDefined()
    } else {
      // A chevron link is the press, the title plain text beside it.
      expect(await ui.find({ type: 'Text', text: /Fix the login bug/ })).toBeDefined()
    }

    // The question shows under the collapsed row, as a press of its own.
    expect(await ui.find({ text: /Add a regression test\?/, ...(surface === 'desktop' && { in: 'point:t1:0' }) })).toBeDefined()

    await pressRow(ui, surface, 't1')
    expect(await ui.find({ type: 'Text', text: /→ Session check fixed in login\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /waiting for you · \d\d:\d\d · 1m12s · 2 tools/ })).toBeDefined()
    expect(await ui.find({ text: /1 file changed/, ...(surface === 'desktop' && { in: 'files:t1' }) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/login.ts' })).toBeUndefined()

    await pressRow(ui, surface, 'files:t1')
    expect(await ui.find({ type: 'Text', text: 'src/login.ts' })).toBeDefined()

    await pressRow(ui, surface, 'prompt:t1')
    expect(await ui.find({ type: 'Text', text: /users get logged out/ })).toBeDefined()

    await pressRow(ui, surface, 'insert:t1')
    expect(fills.at(-1)).toBe('please fix the login bug, users get logged out')

    // Collapse again, so the next surface starts from the same place.
    await pressRow(ui, surface, 'files:t1')
    await pressRow(ui, surface, 'prompt:t1')
    await pressRow(ui, surface, 't1')
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
    const rows = (await ui.findAll({ type: ROWS[surface] })).map(row => row.key)

    expect(rows).toEqual(['t4', 't1'])

    await pressRow(ui, surface, 't1')
    expect(await ui.find({ text: /Translate the README/, ...(surface === 'desktop' && { in: 't1' }) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /README translated, FAQ shortened/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ “also make the FAQ shorter please”/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ “ok danke”/ })).toBeDefined()

    await pressRow(ui, surface, 't1')
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

test('a collapsed task shows its result in one line', async ($, on) => {
  const { clock } = engine(on, () => ({ title: 'Translate the README', result: 'README translated to English' }))

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Translate the README to English', 'Done: the README is in English now.')
  await clock.advance(10)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '    → README translated to English' })).toBeDefined()
    await ui.unmount()
  }
})

test('with result lines off a collapsed task is one line', { options: { resultLines: false } }, async ($, on) => {
  const { clock } = engine(on, () => ({ title: 'Translate the README', result: 'README translated to English' }))

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Translate the README to English', 'Done: the README is in English now.')
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /README translated to English/ })).toBeUndefined()
  await ui.press({ key: 't1' })
  expect(await ui.find({ type: 'Text', text: '→ README translated to English' })).toBeDefined()
  await ui.unmount()
})

test('a press on an open point puts what takes it up into the prompt', async ($, on) => {
  const { clock, fills } = engine(on, () => ({
    title: 'Fix the login bug',
    result: 'Session check fixed',
    openPoints: [{ text: 'Add a regression test?', prompt: 'Yes, add a regression test for the session check' }, 'Release 0.3.0?'],
    isWaitingForUser: true,
  }))

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Fix the login bug', 'Fixed. Add a regression test, or release 0.3.0?')
  await clock.advance(10)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // The first point shows under the collapsed row.
    await pressRow(ui, surface, 'point:t1:0')
    expect(fills.at(-1)).toBe('Yes, add a regression test for the session check')

    // A point the summary gave no reply for puts in the point itself.
    await pressRow(ui, surface, 't1')
    expect(await ui.find({ text: /\? Release 0\.3\.0\?/, ...(surface === 'desktop' && { in: 'point:t1:1' }) })).toBeDefined()
    await pressRow(ui, surface, 'point:t1:1')
    expect(fills.at(-1)).toBe('Release 0.3.0?')

    await pressRow(ui, surface, 't1')
    await ui.unmount()
  }
})

test('a task links back to its prompt in the conversation', async ($, on) => {
  const { clock, toasts } = engine(on, () => null)

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  // The prompt's row kept before its turn starts, and after it.
  await $.session.append(promptRow('row-1', 'Write a changelog entry'))
  await turn($, 't1', 'Write a changelog entry', 'Added the entry.')
  await $.turn.start({ text: 'Bump the version to 0.3.0', turnId: 't2' })
  await $.session.append(promptRow('row-2', 'Bump the version to 0.3.0'))
  await $.turn.complete({ answer: 'Bumped.', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' })
  // A row kept long before the turn is an earlier prompt's: nothing to jump to.
  await $.session.append(promptRow('row-old', 'Tag the release'))
  await clock.advance(61000)
  await turn($, 't3', 'Tag the release', 'Tagged.')
  await clock.advance(10)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    for (const id of ['t1', 't2', 't3']) {
      await pressRow(ui, surface, id)
    }

    expect(await ui.find({ key: 'jump:t1' })).toBeDefined()
    expect(await ui.find({ key: 'jump:t2' })).toBeDefined()
    expect(await ui.find({ key: 'jump:t3' })).toBeUndefined()

    // Collapse again, so the next surface starts from the same place.
    for (const id of ['t1', 't2', 't3']) {
      await pressRow(ui, surface, id)
    }

    await ui.unmount()
  }

  // Here nothing scrolls the conversation: the press says so, and the jump is no longer offered there.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 't1' })
  await ui.press({ key: 'jump:t1' })
  expect(toasts.at(-1)).toMatch(/cannot show the prompt in the conversation/)
  expect(await ui.find({ key: 'jump:t1' })).toBeUndefined()
  expect(await ui.find({ key: 'prompt:t1' })).toBeDefined()
  await ui.unmount()

  // On desktop the jump is a link, a press the person's own; it is offered there until it fails there too.
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ key: 'jump:t1' })).toBeDefined()
  await pressLink(desktop, 'jump:t1')
  expect(await desktop.find({ key: 'jump:t1' })).toBeUndefined()
  await desktop.unmount()
})

test('tasks of earlier days are listed under their day, with clock times', async ($, on) => {
  const yesterday = new Date(2026, 9, 25, 14, 32).getTime()
  const earlier = {
    id: 'old-1',
    prompt: 'Update the README',
    title: 'Update the README',
    result: 'README updated',
    openPoints: [],
    status: 'done',
    startedAt: yesterday,
    endedAt: yesterday + 240000,
    runningSince: null,
    durationMs: 240000,
    tools: 2,
    files: [],
    followUps: [],
    isSummarized: true,
    needsGrouping: false,
  }
  const { clock } = engine(on, () => null, {
    now: new Date(2026, 9, 26, 15, 0).getTime(),
    store: { sessions: ['session-1'], 'session:session-1': [earlier] },
  })

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Write a changelog entry', 'Added the entry.')
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const heads = await ui.findAll({ type: 'Text', text: /^── / })
  expect(heads.map(head => head.text)).toEqual(['── Today ──', '── Yesterday ──'])
  expect((await ui.find({ key: 't1' }))?.text).toMatch(/Write a changelog entry now$/)
  expect((await ui.find({ key: 'old-1' }))?.text).toMatch(/Update the README 14:32$/)

  await ui.press({ key: 'old-1' })
  expect(await ui.find({ type: 'Text', text: 'done · 14:32–14:36 · 4m00s · 2 tools' })).toBeDefined()
  await ui.unmount()
})

test('a list of today alone names no day', async ($, on) => {
  const { clock } = engine(on, () => null, { now: new Date(2026, 9, 26, 15, 0).getTime() })

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Write a changelog entry', 'Added the entry.')
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^── / })).toBeUndefined()
  await ui.press({ key: 't1' })
  expect(await ui.find({ type: 'Text', text: 'done · 15:00 · 1s · 0 tools' })).toBeDefined()
  await ui.unmount()
})

test('tasks rebuilt from a transcript show no time, which is not known', async ($, on) => {
  const { clock } = engine(on, () => null, {
    now: new Date(2026, 9, 26, 15, 0).getTime(),
    messages: [
      { role: 'user', text: 'Fix the flaky test', toolUses: [] },
      { role: 'assistant', text: 'It waits for the server now.', toolUses: [] },
    ],
  })

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '── Earlier ──' })).toBeDefined()
  expect((await ui.find({ key: 'transcript-0' }))?.text).toMatch(/✓ Fix the flaky test\s*$/)
  await ui.press({ key: 'transcript-0' })
  expect(await ui.find({ type: 'Text', text: 'done · 0s · 0 tools' })).toBeDefined()
  await ui.unmount()
})

test('a session another process left out of the index is kept, and goes first', async ($, on) => {
  const listed = Array.from({ length: 30 }, (_, index) => `s${index}`)
  const sessions = Object.fromEntries(listed.map(id => [`session:${id}`, []]))
  const { store } = engine(on, () => null, {
    store: { sessions: listed, ...sessions, 'session:orphan': [] },
  })

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Write a changelog entry', 'Added the entry.')

  // 32 sessions with this one: the orphan, oldest, and s0 make room.
  expect(store.has('session:orphan')).toBe(false)
  expect(store.has('session:s0')).toBe(false)
  expect(store.has('session:s1')).toBe(true)
  expect(store.get('sessions')).toEqual([...listed.slice(1), 'session-1'])
})

test('an unlisted session within the limit joins the index', async ($, on) => {
  const { store } = engine(on, () => null, {
    store: { sessions: ['a'], 'session:a': [], 'session:b': [] },
  })

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Write a changelog entry', 'Added the entry.')

  expect(store.get('sessions')).toEqual(['b', 'a', 'session-1'])
  expect(store.has('session:b')).toBe(true)
})

const ASKS = {
  title: 'Fix the login bug',
  result: 'Session check fixed',
  openPoints: ['Add a regression test?'],
  isWaitingForUser: true,
}

test('an answer that becomes a task of its own still checks the question off', async ($, on) => {
  const prompts: string[] = []
  const { clock } = engine(on, prompt => {
    prompts.push(prompt)

    return request(prompt).includes('Vitest')
      ? { isFollowUp: false, title: 'Add a regression test', result: 'Test added' }
      : ASKS
  })

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Fix the login bug', 'Fixed the session check. Should I add a regression test?')
  await clock.advance(10)
  await turn($, 't2', 'Ja, bitte einen Regressionstest mit Vitest schreiben', 'Added the test.')
  await clock.advance(10)

  // The summary model sees what the task before asked, so it can tell an answer.
  expect(prompts.at(-1)).toMatch(/<previous>[\s\S]*Add a regression test\?[\s\S]*<\/previous>/)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 't1' }))?.text).toMatch(/✓ Fix the login bug/)
  expect(await ui.find({ text: /Add a regression test\?/ })).toBeUndefined()

  await ui.press({ key: 't1' })
  expect(await ui.find({ type: 'Text', text: /✓ Add a regression test\?/ })).toBeDefined()
  expect(await ui.find({ text: /\? Add a regression test\?/ })).toBeUndefined()
  await ui.unmount()
})

test('without a summary an answered task stops waiting', async ($, on) => {
  const { clock } = engine(on, () => null)

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Fix the login bug', 'Fixed. Should I add a regression test?')
  await clock.advance(10)
  await $.turn.start({ text: 'Ja, bitte einen Regressionstest mit Vitest schreiben', turnId: 't2' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 't1' }))?.text).toMatch(/✓ Fix the login bug/)
  await ui.unmount()
})

test('an answer sent before the summary arrives checks its question off', async ($, on) => {
  const { clock, notices } = engine(on, prompt =>
    request(prompt).includes('Vitest') ? { isFollowUp: true, title: 'Fix the login bug', result: 'Fixed, test added' } : ASKS,
  )

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Fix the login bug', 'Fixed. Should I add a regression test?', 45000)
  await $.turn.start({ text: 'Ja, bitte einen Regressionstest mit Vitest schreiben', turnId: 't2' })
  await clock.advance(10)

  // The person is at the keyboard already: no notification about the question.
  expect(notices).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 't1' }))?.text).toMatch(/✓ Fix the login bug/)
  expect(await ui.find({ text: /Add a regression test\?/ })).toBeUndefined()

  await $.turn.complete({ answer: 'Added the test.', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(10)

  expect((await ui.findAll({ type: 'Button' })).map(row => row.key)).toEqual(['t1'])
  await ui.press({ key: 't1' })
  expect(await ui.find({ type: 'Text', text: /✓ Add a regression test\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↳ “Ja, bitte einen Regressionstest/ })).toBeDefined()
  await ui.unmount()
})

test('a short answer checks the question off while the task goes on', async ($, on) => {
  const { clock } = engine(on, prompt =>
    prompt.includes('<followups>') ? { title: 'Fix the login bug', result: 'Fixed, test added' } : ASKS,
  )

  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  await turn($, 't1', 'Fix the login bug', 'Fixed. Should I add a regression test?')
  await clock.advance(10)
  await $.turn.start({ text: 'ja', turnId: 't2' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 't1' })
  expect(await ui.find({ type: 'Text', text: /✓ Add a regression test\?/ })).toBeDefined()
  expect(await ui.find({ text: /\? Add a regression test\?/ })).toBeUndefined()

  await $.turn.complete({ answer: 'Added the test.', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(10)
  expect((await ui.find({ key: 't1' }))?.text).toMatch(/✓ Fix the login bug/)
  expect(await ui.find({ type: 'Text', text: /✓ Add a regression test\?/ })).toBeDefined()
  await ui.unmount()
})
