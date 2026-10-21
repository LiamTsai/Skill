import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'retro',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'retro',
  component: 'Pane',
  requestId: 'retro',
  props: { title: '復盤' },
} as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const REPLY = JSON.stringify({
  suggestions: [
    {
      target: 'global',
      title: '回報完成前，必須自己在實際環境把功能完整跑過一遍',
      why: '同一條糾正累積多次。',
      evidence: ['不是這樣，回報前要先自己測過'],
      append: '說「完成」之前，自己在實際環境把成果完整跑一遍，確認能用才回報。',
    },
  ],
})

test('a correction offers a retrospective whose suggestion is applied to CLAUDE.md', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const k = (path: string) => path.replace(/\\/g, '/')
  const files = new Map<string, string>([['C:/Users/me/.claude/CLAUDE.md', '# rules\n']])

  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? String.raw`C:\Users\me` : undefined }) as never)
  on('session.cwd', () => ({ value: 'C:/work/app' }) as never)
  on('session.messages', () => ({ value: [{ role: 'assistant', text: '做好了，已經部署上線', toolUses: [] }] }) as never)
  on('fs.exists', ($, e) => ({ value: files.has(k(e.path)) }) as never)
  on('fs.read', ($, e) => ({ value: files.get(k(e.path)) }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('fs.write', ($, e) => {
    files.set(k(e.path), e.text)
    return { value: undefined } as never
  })
  on('model.classify', ($, e) => ({ value: e.labels[0] }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: REPLY, usage: USAGE } }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit({ text: '不是這樣，回報前要先自己測過' })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('偵測到糾正')
    await band.unmount()
  }

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'retro:yes' })
  for (let i = 0; i < 5; i++) await clock.advance(1000)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const shown = (await pane.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(shown).toContain('[CLAUDE.md 規則] 回報完成前')
  expect(shown).toContain('證據：「不是這樣，回報前要先自己測過」')

  await pane.press({ key: 'preview:1' })
  expect(await pane.find({ type: 'Code' })).toBeDefined()

  await pane.press({ key: 'apply:1' })
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text)).toContain('✓ 已套用')
  expect(files.get('C:/Users/me/.claude/CLAUDE.md')).toBe(
    '# rules\n\n說「完成」之前，自己在實際環境把成果完整跑一遍，確認能用才回報。\n',
  )
})
