import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'progress-bars',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

test('reported tasks draw as rows that the × removes, on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.tool.call({
    tool: 'mcp__progress-bars__report_progress',
    id: 'reel',
    title: 'Motion graphics showreel',
    percent: 72,
    eta_minutes: 30,
  })
  await $.tool.call({ tool: 'mcp__progress-bars__report_progress', id: 'reel', percent: 72, eta_minutes: 30 })
  await $.tool.call({ tool: 'mcp__progress-bars__report_progress', id: 'panel', title: '任務進度追蹤面板', status: 'done' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toContain('Motion graphics showreel')
    expect(texts).toContain('72%')
    expect(texts).toContain('0s / ~30m')
    expect(texts).toContain('100%')
    expect(texts).toContain('✓')

    await ui.unmount()
  }

  await clock.advance(10 * 60_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('10m / ~20m')
  await ui.press({ key: 'close:self/reel' })
  const after = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(after).not.toContain('Motion graphics showreel')
  expect(after).toContain('任務進度追蹤面板')
  await ui.unmount()
})

test('other sessions draw with their reported progress, and only started ones switch', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  const toasts: string[] = []
  const focused: string[] = []
  const store = new Map<string, unknown>([
    [
      's:local_b',
      {
        id: 'local_b',
        title: 'Fix upload',
        updatedAt: Date.parse('2026-10-20T09:59:00Z'),
        tasks: [{ id: 'up', title: 'localStorage 上傳', percent: 51, etaMinutes: 15, status: 'running', startedAt: Date.parse('2026-10-20T09:57:00Z'), updatedAt: Date.parse('2026-10-20T10:00:00Z'), reports: 2 }],
      },
    ],
    [
      's:local_c',
      {
        id: 'local_c',
        title: 'Old finished',
        updatedAt: Date.parse('2026-09-01T00:00:00Z'),
        tasks: [{ id: 'old', title: '舊工作', percent: 100, etaMinutes: null, status: 'done', startedAt: Date.parse('2026-09-01T00:00:00Z'), updatedAt: Date.parse('2026-09-01T00:30:00Z') }],
      },
    ],
  ])
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('ui.toast', ($, e) => {
    toasts.push(String(e.text))
    return { value: undefined } as never
  })
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_session' }, () => ({
    result: '',
    text: JSON.stringify({ sessionId: 'local_me', title: '進度條 mod' }),
  }))
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__list_sessions' }, () => ({
    result: '',
    text: JSON.stringify([
      { sessionId: 'local_a', title: 'Motion graphics showreel', isRunning: true, lastActivityAt: '2026-10-20T09:59:30Z', startedBy: 'local_me' },
      { sessionId: 'local_b', title: 'Fix upload', isRunning: true, lastActivityAt: '2026-10-20T09:59:00Z' },
      { sessionId: 'local_c', title: 'Old finished', isRunning: false, lastActivityAt: '2026-09-01T00:30:00Z' },
      { sessionId: 'local_d', title: 'Never reported', isRunning: false, lastActivityAt: '2026-09-01T00:00:00Z' },
    ]),
  }))
  on('tool.call', { tool: 'mcp__ccd_window__open_session_in' }, ($, e) => {
    focused.push(String(e.session_id))
    return { result: '', text: 'ok' }
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__progress-bars__${e.name}` } }) as never)
  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await clock.advance(1_500)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Motion graphics showreel')
  expect(texts).toContain('Fix upload')
  expect(texts).toContain('localStorage 上傳')
  expect(texts).toContain('51%')
  expect(texts).toContain('3m / ~15m')
  // Same order everywhere: by each session's first task, sessions with no task last.
  const order = ['Old finished', 'Fix upload', 'Motion graphics showreel', '進度條 mod'].map(name => texts.indexOf(name))
  expect(order).toEqual([...order].sort((a, b) => a - b))
  // Finished long ago, still listed until closed; never reported and idle, not listed.
  expect(texts).toContain('Old finished')
  expect(texts).toContain('30m')
  expect(texts).not.toContain('Never reported')

  await ui.press({ key: 'open:local_a' })
  expect(focused).toEqual(['local_a'])
  await ui.press({ key: 'open:local_b' })
  expect(focused).toEqual(['local_a'])
  expect(toasts.join('\n')).toContain('請從側邊欄點開「Fix upload」')

  // × hides a session for every session, until it reports something newer.
  await ui.press({ key: 'close:local_b' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).not.toContain('localStorage 上傳')
  expect(Object.keys(store.get('hidden') as object)).toEqual(['local_b'])
  await clock.advance(20_000)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).not.toContain('localStorage 上傳')

  const later = Date.parse('2026-10-20T10:00:25Z')
  store.set('s:local_b', {
    id: 'local_b',
    title: 'Fix upload',
    updatedAt: later,
    tasks: [{ id: 'up2', title: '新的一步', percent: 10, etaMinutes: 5, status: 'running', startedAt: later, updatedAt: later }],
  })
  await clock.advance(10_000)
  const after = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(after).toContain('Fix upload')
  expect(after).toContain('新的一步')
  await ui.unmount()
})

test('every request gets a row that "current" updates and the turn closes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__progress-bars__${e.name}` } }) as never)
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_session' }, () => ({ result: '', text: '{}' }))
  on('session.id', () => ({ value: 'cli-session' }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true })

  const submitted = await $.prompt.submit({ text: '復盤也裝成全域' } as never)
  expect(String(submitted.context)).toContain('mcp__progress-bars__report_progress')

  await $.turn.start({ text: '<system-reminder>\nCLAUDE.md\n</system-reminder>\n復盤也裝成全域\n第二行', turnId: 't1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  let texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('0s')
  expect(texts.join(' ')).not.toContain('~')

  // A first report has nothing to estimate from: no time left shows yet.
  await $.tool.call({ tool: 'mcp__progress-bars__report_progress', id: 'current', percent: 5, eta_minutes: 9 })
  texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('5%')
  expect(texts.join(' ')).not.toContain('~')

  await $.tool.call({ tool: 'mcp__progress-bars__report_progress', id: 'current', percent: 40, eta_minutes: 3 })
  texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('復盤也裝成全域')
  expect(texts).toContain('40%')
  expect(texts).toContain('0s / ~3m')

  await clock.advance(5 * 60_000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('100%')
  expect(texts).toContain('✓')
  expect(texts).toContain('5m')

  // A finished request stays, with the time it took, until the person closes it.
  await clock.advance(60 * 60_000)
  texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('復盤也裝成全域')
  expect(texts).toContain('5m')
  await ui.unmount()
})
