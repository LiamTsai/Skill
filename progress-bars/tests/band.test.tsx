import { expect, mock, test } from 'claude-code/testing'
import { rowKey } from '../hooks/register'

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
  await ui.press({ key: rowKey('close', 'self', 'reel') })
  const after = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(after).not.toContain('Motion graphics showreel')
  expect(after).toContain('任務進度追蹤面板')
  await ui.unmount()
})

test('other sessions draw with their reported progress, and a click switches to any of them', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  const toasts: string[] = []
  const focused: string[] = []
  const opened: string[][] = []
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
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_session' }, ($, e) => ({
    result: '',
    text: JSON.stringify(
      e.session_id === 'self'
        ? { sessionId: 'local_me', title: '進度條 mod' }
        : { sessionId: e.session_id, link: `claude://claude.ai/epitaxy/${String(e.session_id)}` },
    ),
  }))
  on('process.run', ($, e) => {
    opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__list_sessions' }, () => ({
    result: '',
    text: JSON.stringify([
      // The app lists this session too; it draws once, from its own tasks.
      { sessionId: 'local_me', title: '進度條 mod', isRunning: true, lastActivityAt: '2026-10-20T10:00:00Z' },
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
  // Other sessions fold to one summary line until ▸ opens them.
  const folded = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(folded).toContain('  ● 1 執行中 51%')
  expect(folded).toContain('  ✓ 1')
  expect(folded).not.toContain('localStorage 上傳')
  await ui.press({ key: 'fold:local_b' })
  await ui.press({ key: 'fold:local_c' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Motion graphics showreel')
  expect(texts.filter(t => t === '進度條 mod')).toHaveLength(1)
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
  expect(opened).toEqual([])
  // One this session did not start opens through its claude:// link.
  await ui.press({ key: 'open:local_b' })
  expect(focused).toEqual(['local_a'])
  expect(opened).toEqual([['rundll32', 'url.dll,FileProtocolHandler', 'claude://claude.ai/epitaxy/local_b']])
  expect(toasts).toEqual([])

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

test('syncs failing in a row show a warning row until a sync succeeds again', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  let listed = 'not json'
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_session' }, () => ({
    result: '',
    text: JSON.stringify({ sessionId: 'local_me', title: '進度條 mod' }),
  }))
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__list_sessions' }, () => ({ result: '', text: listed }))
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__progress-bars__${e.name}` } }) as never)
  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // One failed sync is likely the shared file caught mid-write: no warning yet.
  await clock.advance(1_500)
  let texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.join(' ')).not.toContain('同步失敗')
  await clock.advance(20_000)
  texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.join(' ')).toContain('同步失敗')

  listed = '[]'
  await clock.advance(10_000)
  texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.join(' ')).not.toContain('同步失敗')
  await ui.unmount()
})

test('a store read caught mid-write keeps the rows last read', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  let isBroken = false
  const entry = {
    id: 'local_b',
    title: 'Fix upload',
    updatedAt: Date.parse('2026-10-20T09:59:00Z'),
    tasks: [{ id: 'up', title: 'localStorage 上傳', percent: 51, etaMinutes: 15, status: 'running', startedAt: Date.parse('2026-10-20T09:57:00Z'), updatedAt: Date.parse('2026-10-20T10:00:00Z'), reports: 2 }],
  }
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('store.get', ($, e) => {
    if (isBroken) return { deny: 'store file is malformed (JSON Parse error: Unexpected EOF)' } as never
    return { value: e.key === 's:local_b' ? entry : undefined } as never
  })
  on('store.set', () => ({ value: undefined }) as never)
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_session' }, () => ({
    result: '',
    text: JSON.stringify({ sessionId: 'local_me', title: '進度條 mod' }),
  }))
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__list_sessions' }, () => ({
    result: '',
    text: JSON.stringify([{ sessionId: 'local_b', title: 'Fix upload', isRunning: true, lastActivityAt: '2026-10-20T09:59:00Z' }]),
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__progress-bars__${e.name}` } }) as never)
  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await clock.advance(1_500)
  await ui.press({ key: 'fold:local_b' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('localStorage 上傳')
  isBroken = true
  await clock.advance(10_000)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('localStorage 上傳')
  expect(texts.join(' ')).not.toContain('同步失敗')
  await ui.unmount()
})

test('once a day the store drops what no band can draw again, and keeps every row still shown', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  const task = (id: string) => ({ id, title: id, percent: 100, etaMinutes: null, status: 'done', startedAt: 1, updatedAt: 2 })
  const store = new Map<string, unknown>([
    ['s:local_b', { id: 'local_b', title: 'Alive', updatedAt: 2, tasks: [task('up'), task('a/b')] }],
    ['s:local_archived', { id: 'local_archived', title: 'Archived', updatedAt: 2, tasks: [task('x')] }],
    ['s:local_deleted', { id: 'local_deleted', title: 'Deleted', updatedAt: 2, tasks: [task('y')] }],
    ['sync:local_b', 'ok'],
    ['sync:last-error', 'error: x'],
    [
      'hidden',
      { local_b: 5, 'local_b/up': 5, 'local_b/a/b': 5, 'local_b/cleared': 5, local_archived: 5, 'local_deleted/y': 5, local_unread: 5 },
    ],
  ])
  let lookups = 0
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_session' }, ($, e) => {
    const id = String(e.session_id)
    if (id === 'self') return { result: '', text: JSON.stringify({ sessionId: 'local_me', title: '進度條 mod' }) }
    lookups++
    if (id === 'local_deleted') return { result: '', isError: true, text: `Session ${id} not found.` } as never
    // A lookup that fails for any other reason keeps what it holds.
    if (id === 'local_unread') return { result: '', isError: true, text: 'app not reachable' } as never
    return { result: '', text: JSON.stringify({ sessionId: id, isArchived: id === 'local_archived' }) }
  })
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__list_sessions' }, () => ({
    result: '',
    text: JSON.stringify([{ sessionId: 'local_b', title: 'Alive', isRunning: true, lastActivityAt: '2026-10-20T09:59:00Z' }]),
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__progress-bars__${e.name}` } }) as never)
  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await clock.advance(1_500)

  expect([...store.keys()].filter(k => k !== 'cleanedAt').sort()).toEqual(['hidden', 's:local_b', 's:local_me', 'sync:last-error'])
  expect(Object.keys(store.get('hidden') as object).sort()).toEqual(['local_b', 'local_b/a/b', 'local_b/up', 'local_unread'])

  // Another session starting the same day leaves it to tomorrow.
  const before = lookups
  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await clock.advance(1_500)
  expect(lookups).toBe(before)
})

test('this session draws once though the app lists it, and its rows keep updating', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-24T00:00:19Z') })
  const store = new Map<string, unknown>()
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_session' }, () => ({
    result: '',
    text: JSON.stringify({ sessionId: 'local_me', title: 'UO訂單領取條件' }),
  }))
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__list_sessions' }, () => ({
    result: '',
    text: JSON.stringify([{ sessionId: 'local_me', title: 'UO訂單領取條件', isRunning: true, lastActivityAt: '2026-10-24T00:00:20Z' }]),
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__progress-bars__${e.name}` } }) as never)
  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'UO訂單的領取條件?', turnId: 't1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await clock.advance(1_500)
  expect((await texts()).filter(t => t === 'UO訂單領取條件')).toHaveLength(1)

  await $.tool.call({ tool: 'mcp__progress-bars__report_progress', id: 'current', title: '查 BOD 領取條件', percent: 5 })
  await clock.advance(30_000)
  expect(await texts()).toContain('5%')
  expect(await texts()).toContain('30s')

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  const after = await texts()
  expect(after).toContain('✓')
  expect(after).not.toContain('●')
  expect(after.filter(t => t === '查 BOD 領取條件')).toHaveLength(1)
  await ui.unmount()
})

test('every key the band draws is short, plain and unique, whatever the task ids', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-24T04:47:30Z') })
  const started = Date.parse('2026-10-24T04:00:00Z')
  const task = (id: string) => ({ id, title: id, percent: 100, etaMinutes: null, status: 'done', startedAt: started, updatedAt: started })
  const store = new Map<string, unknown>([
    [
      's:local_ed66f1f4-615f-4337-ba17-68cdc9269e7c',
      {
        id: 'local_ed66f1f4-615f-4337-ba17-68cdc9269e7c',
        title: 'UO訂單領取條件',
        updatedAt: started,
        tasks: [task('agent:Implement BOD ticket 03'), task('agent:Implement BOD ticket 04'), task('agent:實作切片 01 子／彈'), task('req:5f6225ec-b891-421a-90d7-a92d80620c39')],
      },
    ],
  ])
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_session' }, () => ({
    result: '',
    text: JSON.stringify({ sessionId: 'local_a019cb30-5aca-416c-9eb7-bab41540fc12', title: '待辦事項清單' }),
  }))
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__list_sessions' }, () => ({
    result: '',
    text: JSON.stringify([{ sessionId: 'local_ed66f1f4-615f-4337-ba17-68cdc9269e7c', title: 'UO訂單領取條件', isRunning: false, lastActivityAt: '2026-10-24T04:00:00Z' }]),
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__progress-bars__${e.name}` } }) as never)
  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await clock.advance(1_500)
  await ui.press({ key: 'fold:local_ed66f1f4-615f-4337-ba17-68cdc9269e7c' })
  const nodes = [...(await ui.findAll({ type: 'Button' })), ...(await ui.findAll({ type: 'Box' }))]
  const keys = nodes.map(n => n.key).filter((k): k is string => typeof k === 'string')
  expect(keys.filter(k => k.startsWith('close:'))).toHaveLength(6)
  expect(keys).toContain('fold:local_ed66f1f4-615f-4337-ba17-68cdc9269e7c')
  for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_:-]{1,64}$/)
  expect(new Set(keys).size).toBe(keys.length)
  await ui.unmount()
})
