import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Draft, SavedPrompt } from '../types'

// Change the tag when SavedPrompt's fields change: it declines what an earlier
// version stored, which outlives a reload.
const prompts = atom({ plugin: 'prompt-library', key: 'prompts' } as const, [], { shape: 'prompts-1' })
const draft = atom({ plugin: 'prompt-library', key: 'draft' } as const, null)
const lastSent = atom({ plugin: 'prompt-library', key: 'lastSent' } as const, '')
const isHereOnly = atom({ plugin: 'prompt-library', key: 'isHereOnly' } as const, false)
const deleting = atom({ plugin: 'prompt-library', key: 'deleting' } as const, null)
const query = atom({ plugin: 'prompt-library', key: 'query' } as const, '')

const LIBRARY = 'prompt-library'
const EDITOR = 'prompt-edit'
// The store holds the list across sessions and projects; the atom above only
// mirrors it so the panes redraw.
const STORE_KEY = 'prompts'
// The person's own prompts; other user-role rows (task notifications, other
// sessions' messages) get no save button.
const OWN = ['composer', 'bridge', 'sdk', 'unclassified']

const slash = (p: string) => p.replace(/\\/g, '/').toLowerCase()
const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const isPrompt = (v: unknown): v is SavedPrompt =>
  typeof v === 'object' && v !== null && typeof (v as SavedPrompt).id === 'string' && typeof (v as SavedPrompt).text === 'string'
const asList = (v: unknown): SavedPrompt[] => (Array.isArray(v) ? v.filter(isPrompt) : [])

// How well `term` matches `hay` when its characters appear in order with gaps
// allowed (公戰 finds 公會戰): consecutive characters and ones at a word's start
// count more; -1 when they do not all appear.
function subsequence(term: string, hay: string): number {
  let i = 0
  let last = -2
  let score = 0
  for (let j = 0; j < hay.length && i < term.length; j++) {
    if (hay[j] !== term[i]) continue
    score += j === last + 1 ? 3 : 1
    if (j === 0 || /[\s_\-/.，。]/.test(hay[j - 1] ?? '')) score += 2
    last = j
    i++
  }
  return i === term.length ? score : -1
}

// Every space-separated term must match the name or the text; a match in the
// name counts double. null when the prompt does not match.
function fuzzy(q: string, p: SavedPrompt): number | null {
  const terms = q.toLowerCase().split(/\s+/).filter(t => t !== '')
  const name = p.name.toLowerCase()
  const text = p.text.toLowerCase()
  let total = 0
  for (const t of terms) {
    const inName = subsequence(t, name)
    const best = Math.max(inName < 0 ? -1 : inName * 2, subsequence(t, text))
    if (best < 0) return null
    total += best
  }
  return total
}

// Read the store fresh on every change, so a prompt another session saved
// meanwhile is kept.
async function change($: EngineInterface, fn: (list: SavedPrompt[]) => SavedPrompt[]) {
  const list = fn(asList(await $.store.get(STORE_KEY)))
  await $.store.set(STORE_KEY, list)
  await update($, prompts, () => list)
}

async function openEditor($: EngineInterface, d: Draft) {
  await update($, draft, () => d)
  await $.ui.open({ id: EDITOR, title: d.id === null ? '存提示詞' : '編輯提示詞', focus: true })
}

// Reload the list from the store, which other sessions may have changed.
async function reload($: EngineInterface) {
  const list = asList(await $.store.get(STORE_KEY))
  await update($, prompts, () => list)
}

async function openLibrary($: EngineInterface) {
  await reload($)
  await update($, query, () => '')
  await $.ui.open({ id: LIBRARY, title: '提示詞庫' })
}

async function save($: EngineInterface) {
  const d = await read($, draft)
  if (d === null || d.text.trim() === '') return
  const now = await $.clock.now()
  const name = d.name.trim() || clip(firstLine(d.text), 40)
  if (d.id === null) {
    const one: SavedPrompt = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      text: d.text,
      cwd: await $.session.cwd(),
      savedAt: now,
      updatedAt: now,
    }
    await change($, list => [...list, one])
    $.ui.toast(`已存：${name}`)
  } else {
    await change($, list => list.map(p => (p.id === d.id ? { ...p, name, text: d.text, updatedAt: now } : p)))
    $.ui.toast(`已更新：${name}`)
  }
  await update($, draft, () => null)
  await $.ui.close({ id: EDITOR })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'prompts', description: '打開提示詞庫：填入、編輯或刪除存過的提示詞' })
    await $.command.register({ name: 'save-prompt', description: '存上一則送出的提示詞（存之前可以編輯）' })
    await reload($)
    return next(e)
  })

  on('command.run', { command: 'prompts' }, async $ => {
    await openLibrary($)
    return { text: '已打開提示詞庫。' }
  })

  on('command.run', { command: 'save-prompt' }, async $ => {
    const text = await read($, lastSent)
    if (text === '') return { text: '這個 session 還沒有送出過提示詞。' }
    await openEditor($, { id: null, name: '', text })
    return { text: '在「存提示詞」面板確認內容後按「存」。' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined && e.isMeta !== true && e.text.trim() !== '') {
      await update($, lastSent, () => e.text)
    }
    return next(e)
  })

  // A button in the band right above the prompt box opens the library; the
  // desktop app draws no hint line under its prompt box, but it draws the band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { Box, Button } = $.ui.resolve(e)
    const open = <Button key="band:prompts" plain label="☰ 提示詞" onPress={() => openLibrary($)} />
    return below ? (
      <Box flexDirection="column">
        {below}
        {open}
      </Box>
    ) : (
      open
    )
  })

  // Trial: the same button beside the mode labels in the prompt footer, to see
  // whether the desktop app draws that site near its model picker.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const below = await next(e)
    const { Box, Button } = $.ui.resolve(e)
    const open = <Button key="mode:prompts" plain label="☰ 提示詞" onPress={() => openLibrary($)} />
    return below ? (
      <Box flexDirection="row" gap={1}>
        {open}
        {below}
      </Box>
    ) : (
      open
    )
  })

  // A ☆ 存 button that shows while the pointer is over one of your own prompts.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const below = await next(e)
    const p = e.props
    if (!below || p.task !== undefined || p.from !== undefined || !OWN.includes(p.origin.kind) || p.text.trim() === '') {
      return below
    }
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box key={`msg:${e.requestId}`} flexDirection="column">
        {below}
        <Box position="absolute" top={0} right={0} display="none" hover={{ display: 'flex' }}>
          <Button
            key={`save:${e.requestId}`}
            plain
            label="☆ 存"
            onPress={() => openEditor($, { id: null, name: '', text: p.text })}
          />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: EDITOR }, async ($, e) => {
    const d = await read($, draft)
    const cancel = async () => {
      await update($, draft, () => null)
      await $.ui.close({ id: EDITOR })
    }

    // Mobile draws no text field: the prompt can be saved as it is.
    if (e.surface === 'mobile') {
      const { Box, Text, Button } = $.ui.resolve(e)
      if (d === null) return <Text dimColor>沒有要存的提示詞。</Text>
      return (
        <Box flexDirection="column" gap={1}>
          <Text>{d.text}</Text>
          <Text dimColor>手機上無法編輯，可以先存，之後在電腦上編輯。</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="edit:save" variant="primary" label="存" onPress={() => save($)} />
            <Button key="edit:cancel" label="取消" onPress={cancel} />
          </Box>
        </Box>
      )
    }

    const { Box, Text, Button, Input } = $.ui.resolve(e)
    if (d === null) return <Text dimColor>沒有要存的提示詞。</Text>

    return (
      <Box flexDirection="column" gap={1}>
        <Input
          key="edit:name"
          label="名稱"
          placeholder={clip(firstLine(d.text), 40) || '留空就用第一行'}
          value={d.name}
          submitLabel="下一欄"
          onInput={v => update($, draft, x => (x === null ? x : { ...x, name: v }))}
          onSubmit={() => $.ui.focus({ requestId: EDITOR, key: 'edit:text' })}
        />
        <Input
          key="edit:text"
          label="內容"
          rows={8}
          autoFocus
          value={d.text}
          submitLabel="存"
          onInput={v => update($, draft, x => (x === null ? x : { ...x, text: v }))}
          onSubmit={async v => {
            await update($, draft, x => (x === null ? x : { ...x, text: v }))
            await save($)
          }}
        />
        <Box flexDirection="row" gap={1}>
          <Button key="edit:save" variant="primary" label="存" onPress={() => save($)} />
          <Button key="edit:cancel" label="取消" onPress={cancel} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: LIBRARY }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const here = slash(await $.session.cwd())
    const hereOnly = await read($, isHereOnly)
    const pending = await read($, deleting)
    const q = (await read($, query)).trim()
    const all = [...(await read($, prompts))].sort((a, b) => b.savedAt - a.savedAt)
    const inScope = hereOnly ? all.filter(p => slash(p.cwd) === here) : all
    // With a search, best match first; ties keep the newest first.
    const list =
      q === ''
        ? inScope
        : inScope
            .map(p => ({ p, score: fuzzy(q, p) }))
            .filter((m): m is { p: SavedPrompt; score: number } => m.score !== null)
            .sort((a, b) => b.score - a.score)
            .map(m => m.p)
    // Mobile draws no text field.
    const search =
      e.surface === 'mobile'
        ? null
        : (() => {
            const { Input } = $.ui.resolve(e)
            return (
              <Input
                key="lib:search"
                label="搜尋"
                placeholder="名稱或內容，字可以不連續"
                value={q}
                onInput={v => update($, query, () => v)}
                onSubmit={v => update($, query, () => v)}
              />
            )
          })()

    const fill = async (p: SavedPrompt) => {
      const filled = await $.prompt.fill({ text: p.text, mode: 'insert' })
      $.ui.toast(filled.isFilled ? `已填入：${p.name}` : '現在無法填入輸入框')
    }
    const saveDraft = async () => {
      const { text } = await $.prompt.read()
      if (text.trim() === '') $.ui.toast('輸入框是空的')
      else await openEditor($, { id: null, name: '', text })
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Button
            key="lib:scope"
            label={hereOnly ? '只看這個專案' : '全部專案'}
            onPress={() => update($, isHereOnly, v => !v)}
          />
          <Button key="lib:draft" label="存目前的草稿" onPress={saveDraft} />
        </Box>
        {all.length > 0 && search}
        {list.length === 0 && (
          <Text dimColor>
            {all.length === 0
              ? '還沒有存任何提示詞。滑鼠移到你送出的訊息上按「☆ 存」，或用 /save-prompt 存上一則。'
              : q !== ''
                ? `找不到符合「${q}」的提示詞。`
                : '這個專案還沒有存過提示詞。'}
          </Text>
        )}
        {list.map(p => (
          <Box key={`item:${p.id}`} flexDirection="column">
            <Text weight="bold" wrap="truncate-end">
              {p.name}
              {slash(p.cwd) !== here && <Text dimColor> · {p.cwd.replace(/\\/g, '/').split('/').pop()}</Text>}
            </Text>
            <Text dimColor wrap="truncate-end">
              {firstLine(p.text)}
            </Text>
            {pending === p.id ? (
              <Box flexDirection="row" gap={1}>
                <Text color="error">確定刪除？</Text>
                <Button
                  key={`confirm:${p.id}`}
                  label="確定"
                  onPress={async () => {
                    await change($, l => l.filter(x => x.id !== p.id))
                    await update($, deleting, () => null)
                  }}
                />
                <Button key={`keep:${p.id}`} label="取消" onPress={() => update($, deleting, () => null)} />
              </Box>
            ) : (
              <Box flexDirection="row" gap={1}>
                <Button key={`fill:${p.id}`} variant="primary" label="填入" onPress={() => fill(p)} />
                <Button
                  key={`edit:${p.id}`}
                  label="編輯"
                  onPress={() => openEditor($, { id: p.id, name: p.name, text: p.text })}
                />
                <Button key={`delete:${p.id}`} label="刪除" onPress={() => update($, deleting, () => p.id)} />
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
