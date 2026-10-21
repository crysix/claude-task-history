import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

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

/** The engine beneath the mod: the calls it makes, answered from memory. */
function engine(on: On, reply: (prompt: string) => Reply | null) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
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

  return clock
}

/** A summary prompt less the task before, the part the mock answers by. */
function request(prompt: string): string {
  return prompt.replace(/<previous>[\s\S]*<\/previous>/, '')
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
  const clock = engine(on, () => ({
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

    expect((await ui.find({ key: 't1' }))?.text).toMatch(/\? Fix the login bug/)
    expect(await ui.find({ type: 'Text', text: /Add a regression test\?/ })).toBeDefined()

    await ui.press({ key: 't1' })
    expect(await ui.find({ type: 'Text', text: /→ Session check fixed in login\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /waiting for you · 1m12s · 2 tools/ })).toBeDefined()
    expect((await ui.find({ key: 'files:t1' }))?.text).toMatch(/1 file changed/)
    expect(await ui.find({ type: 'Text', text: 'src/login.ts' })).toBeUndefined()

    await ui.press({ key: 'files:t1' })
    expect(await ui.find({ type: 'Text', text: 'src/login.ts' })).toBeDefined()

    await ui.press({ key: 'prompt:t1' })
    expect(await ui.find({ type: 'Text', text: /users get logged out/ })).toBeDefined()

    // Collapse again, so the next surface starts from the same place.
    await ui.press({ key: 'files:t1' })
    await ui.press({ key: 'prompt:t1' })
    await ui.press({ key: 't1' })
    await ui.unmount()
  }
})

test('replies and follow-ups fold into the task they continue', async ($, on) => {
  const clock = engine(on, prompt =>
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
    const rows = (await ui.findAll({ type: 'Button' })).map(row => row.key)

    expect(rows).toEqual(['t4', 't1'])

    await ui.press({ key: 't1' })
    expect((await ui.find({ key: 't1' }))?.text).toMatch(/Translate the README/)
    expect(await ui.find({ type: 'Text', text: /README translated, FAQ shortened/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ “also make the FAQ shorter please”/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ “ok danke”/ })).toBeDefined()

    await ui.press({ key: 't1' })
    await ui.unmount()
  }
})

test('without a summary the raw prompt and reply stay', async ($, on) => {
  const clock = engine(on, () => null)

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
