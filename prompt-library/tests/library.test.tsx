import { expect, mock, test } from 'claude-code/testing'

const MESSAGE = {
  plugin: 'prompt-library',
  component: 'UserMessage',
  requestId: 'm1',
  props: { text: '幫我把這個函式拆成兩個', origin: { kind: 'composer' }, isExpanded: false },
} as const

const PANE = {
  plugin: 'prompt-library',
  component: 'Pane',
  props: {
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const
const EDITOR = { ...PANE, requestId: 'prompt-edit', props: { ...PANE.props, title: '存提示詞' } } as const
const LIBRARY = { ...PANE, requestId: 'prompt-library', props: { ...PANE.props, title: '提示詞庫' } } as const

type On = Parameters<typeof mock.store>[0]

function engine(on: On, seed: Record<string, unknown> = {}) {
  mock.clock(on)
  const store = new Map(Object.entries(seed))
  const fills: Array<{ text: string; mode?: string }> = []
  on('store.get', ($, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.focus', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.cwd', () => ({ value: 'C:\\work\\game' }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.read', () => ({ value: { text: '草稿內容', cursor: 4 } }) as never)
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true } as never
  })
  return { fills, store }
}

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<Array<{ text: string }>> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')

test('a sent prompt is saved after editing, then filled back into the prompt box', async ($, on) => {
  const { fills, store } = engine(on)
  await $.session.start({ cwd: 'C:\\work\\game', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ ...MESSAGE, surface })
    expect(await texts(row)).toContain('engine row')
    await row.press({ key: 'save:m1' })
    await row.unmount()

    const editor = await $.ui.mount({ ...EDITOR, surface })
    await editor.input({ key: 'edit:name', text: `拆函式 ${surface}`, kind: 'change' })
    await editor.input({ key: 'edit:text', text: '幫我把這個函式拆成兩個，保留測試', kind: 'change' })
    await editor.press({ key: 'edit:save' })
    await editor.unmount()
  }

  const library = await $.ui.mount({ ...LIBRARY, surface: 'desktop' })
  const shown = await texts(library)
  expect(shown).toContain('拆函式 terminal')
  expect(shown).toContain('拆函式 desktop')
  expect(shown).toContain('幫我把這個函式拆成兩個，保留測試')

  const saved = store.get('prompts') as Array<{ id: string; name: string }>
  expect(saved.length).toBe(2)
  const first = saved[0]!
  await library.press({ key: `fill:${first.id}` })
  expect(fills).toEqual([{ text: '幫我把這個函式拆成兩個，保留測試', mode: 'insert' }])
  await library.unmount()
})

test('a saved prompt is edited later, and deleted only after 確定', async ($, on) => {
  const { store } = engine(on, {
    prompts: [{ id: 'a', name: '舊名稱', text: '舊內容', cwd: 'C:\\work\\game', savedAt: 1, updatedAt: 1 }],
  })
  await $.session.start({ cwd: 'C:\\work\\game', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const library = await $.ui.mount({ ...LIBRARY, surface })
    await library.press({ key: 'edit:a' })
    await library.unmount()

    const editor = await $.ui.mount({ ...EDITOR, surface })
    await editor.input({ key: 'edit:text', text: `新內容 ${surface}` })
    await editor.unmount()
  }

  const saved = store.get('prompts') as Array<{ name: string; text: string }>
  expect(saved).toEqual([expect.objectContaining({ name: '舊名稱', text: '新內容 desktop' })])

  const library = await $.ui.mount({ ...LIBRARY, surface: 'desktop' })
  await library.press({ key: 'delete:a' })
  expect(await texts(library)).toContain('確定刪除？')
  expect((store.get('prompts') as unknown[]).length).toBe(1)

  await library.press({ key: 'keep:a' })
  expect((store.get('prompts') as unknown[]).length).toBe(1)

  await library.press({ key: 'delete:a' })
  await library.press({ key: 'confirm:a' })
  expect(store.get('prompts') as unknown[]).toEqual([])
  expect(await texts(library)).toContain('還沒有存任何提示詞')
  await library.unmount()
})

test('/save-prompt opens the last prompt sent; other projects can be hidden', async ($, on) => {
  engine(on, { prompts: [{ id: 'x', name: '別的專案', text: '別處', cwd: 'D:\\other', savedAt: 1, updatedAt: 1 }] })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.session.start({ cwd: 'C:\\work\\game', surface: 'desktop', isInteractive: true })

  await $.prompt.submit({ text: '寫一份公會戰規格', wait: false, origin: { kind: 'composer' } })
  await $.command.run({ command: 'save-prompt', args: '' } as never)

  const editor = await $.ui.mount({ ...EDITOR, surface: 'desktop' })
  await editor.press({ key: 'edit:save' })
  await editor.unmount()

  const library = await $.ui.mount({ ...LIBRARY, surface: 'desktop' })
  expect(await texts(library)).toContain('別的專案')
  expect(await texts(library)).toContain('寫一份公會戰規格')

  await library.press({ key: 'lib:scope' })
  const here = await texts(library)
  expect(here).not.toContain('別的專案')
  expect(here).toContain('寫一份公會戰規格')
  await library.unmount()
})

test('rows that are not your own prompts get no save button', async ($, on) => {
  engine(on)
  const row = await $.ui.mount({
    ...MESSAGE,
    props: { ...MESSAGE.props, origin: { kind: 'task-notification' } },
    surface: 'desktop',
  })
  expect(await row.find({ key: 'save:m1' })).toBeUndefined()
  await row.unmount()
})
