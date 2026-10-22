import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Correction, Suggestion } from '../types'

const pending = atom({ plugin: 'retro', key: 'pending' } as const, null)
const phase = atom({ plugin: 'retro', key: 'phase' } as const, 'idle')
const error = atom({ plugin: 'retro', key: 'error' } as const, '')
const suggestions = atom({ plugin: 'retro', key: 'suggestions' } as const, [])

const PANE = 'retro'
const STORE_KEY = 'corrections'
const LABELS = ['the user corrects, rejects or pushes back on what the assistant did or said', 'anything else'] as const

const SYSTEM = `You run a retrospective on how Claude Code (an AI coding agent) works with one person.
You get the corrections the person made (their own words, the reply they corrected, and the project folder), the recent conversation, the person's global AGENTS.md, the project's AGENTS.md, and their skills.
You also get the global and project CLAUDE.md as reference only: never target them, and treat their rules like rules already written.
Propose at most 3 changes that would stop the corrected behaviour from happening again. Each change is text appended to the END of exactly one file:
- "global": the global AGENTS.md, for working habits that hold across projects (corrections seen in several project folders point here)
- "project": this project's AGENTS.md, for something true of this project alone
- "skill:<name>": an existing skill's SKILL.md, when the correction is about what that skill does
Rules: propose nothing a file already says unless it needs to be stronger; one concrete, checkable rule per change, written as an instruction to the agent; evidence is short verbatim quotes of the person's words; propose nothing when the evidence is thin.
Write title, why and append in the same language the person writes in.
Reply with JSON only, no prose and no code fence:
{"suggestions":[{"target":"global","title":"one line","why":"two or three sentences: what keeps going wrong and why this file","evidence":["quote"],"append":"the lines to append"}]}`

let isRunning = false

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const slash = (p: string) => p.replace(/\\/g, '/')
const asList = (v: unknown): Correction[] => (Array.isArray(v) ? (v as Correction[]) : [])
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

type Skill = { name: string; file: string; head: string }

function buildPrompt(p: {
  corrections: Correction[]
  recent: string
  globalFile: string
  globalText: string | null
  projectFile: string
  projectText: string | null
  globalRefFile: string
  globalRefText: string | null
  projectRefFile: string
  projectRefText: string | null
  skills: Skill[]
}): string {
  return [
    `## Corrections (oldest first)\n${
      p.corrections
        .map((c, i) => `${i + 1}. [${c.cwd}] person: "${c.text}"\n   corrected reply: ${clip(c.assistant, 400)}`)
        .join('\n') || '(none recorded)'
    }`,
    `## Recent conversation\n${p.recent || '(none)'}`,
    `## Global AGENTS.md (${p.globalFile})\n${p.globalText ?? '(missing)'}`,
    `## Project AGENTS.md (${p.projectFile})\n${p.projectText ?? '(missing)'}`,
    `## Global CLAUDE.md, reference only (${p.globalRefFile})\n${p.globalRefText ?? '(missing)'}`,
    `## Project CLAUDE.md, reference only (${p.projectRefFile})\n${p.projectRefText ?? '(missing)'}`,
    `## Skills\n${p.skills.map(k => `### ${k.name}\n${k.head}`).join('\n') || '(none)'}`,
  ].join('\n\n')
}

function toSuggestions(raw: string, globalFile: string, projectFile: string, skills: Skill[]): Suggestion[] {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) return []
  const parsed = JSON.parse(raw.slice(start, end + 1)) as { suggestions?: unknown }
  const items = Array.isArray(parsed.suggestions) ? (parsed.suggestions as Array<Record<string, unknown>>) : []

  const found: Suggestion[] = []
  for (const [i, item] of items.entries()) {
    const target = String(item.target ?? '')
    const append = String(item.append ?? '').trim()
    if (append === '') continue
    let file: string
    let kind: string
    if (target === 'global') {
      file = globalFile
      kind = 'AGENTS.md 規則'
    } else if (target === 'project') {
      file = projectFile
      kind = '專案 AGENTS.md'
    } else if (target.startsWith('skill:')) {
      const skill = skills.find(k => k.name === target.slice(6))
      if (skill === undefined) continue
      file = skill.file
      kind = `Skill: ${skill.name}`
    } else {
      continue
    }
    found.push({
      id: String(i + 1),
      kind,
      title: String(item.title ?? ''),
      why: String(item.why ?? ''),
      evidence: Array.isArray(item.evidence) ? item.evidence.map(String) : [],
      file,
      append,
      status: 'open',
      isExpanded: false,
    })
  }
  return found
}

function asDiff(append: string): string {
  const lines = append.split('\n')
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'retro', description: '針對最近的糾正做復盤，提出 AGENTS.md / Skill 修改建議' })
    return next(e)
  })

  // /retro asks the same question the band asks after a correction.
  on('command.run', { command: 'retro' }, async $ => {
    const last = asList(await $.store.get(STORE_KEY)).at(-1)
    const manual: Correction = { text: '手動復盤', assistant: '', cwd: await $.session.cwd(), at: await $.clock.now() }
    await update($, pending, () => last ?? manual)
    return { text: '在輸入框上方按「要」開始復盤。' }
  })

  // Judge each typed prompt in the background, never holding it up.
  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    if (e.command !== undefined || e.isMeta === true || text === '' || text.length > 800) return next(e)

    const messages = await $.session.messages()
    const prev = Array.isArray(messages)
      ? [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')
      : undefined
    if (prev === undefined) return next(e)
    const assistant = clip(prev.text, 1500)

    $.clock.after(0, () => {
      void (async () => {
        const label = await $.model
          .classify(`Assistant's previous reply:\n${assistant}\n\nUser's new message:\n${text}`, LABELS)
          .catch(() => undefined)
        if (label !== LABELS[0]) return
        const correction: Correction = { text, assistant, cwd: await $.session.cwd(), at: await $.clock.now() }
        await $.store.set(STORE_KEY, [...asList(await $.store.get(STORE_KEY)), correction].slice(-50))
        await update($, pending, () => correction)
      })()
    })

    return next(e)
  })

  // The 要 button starts the retrospective, in the background.
  on('ui.press', { plugin: 'retro', element: 'retro:yes' }, async ($, e, next) => {
    const result = await next(e)
    if (isRunning) return result
    isRunning = true

    $.clock.after(0, () => {
      void (async () => {
        try {
          await update($, error, () => '')
          await update($, suggestions, () => [])
          void $.ui.open({ id: PANE, title: '復盤' })
          const home = slash((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~')
          const cwd = slash(await $.session.cwd())
          const globalFile = `${home}/.claude/AGENTS.md`
          const projectFile = `${cwd}/AGENTS.md`
          const skillsDir = `${home}/.claude/skills`
          const readIf = async (path: string, max: number) =>
            (await $.fs.exists(path).catch(() => false)) ? clip(String(await $.fs.read(path)), max) : null

          const skills: Skill[] = []
          const entries = await $.fs.list(skillsDir).catch(() => [])
          for (const entry of entries) {
            if (entry.kind !== 'directory') continue
            const file = `${skillsDir}/${entry.name}/SKILL.md`
            const head = await readIf(file, 400)
            if (head !== null) skills.push({ name: entry.name, file, head })
          }

          const messages = await $.session.messages()
          const recent = Array.isArray(messages)
            ? messages
                .slice(-14)
                .map(m => `${m.role}: ${clip(m.text, 700)}`)
                .join('\n\n')
            : ''

          const prompt = buildPrompt({
            corrections: asList(await $.store.get(STORE_KEY)).slice(-20),
            recent,
            globalFile,
            globalText: await readIf(globalFile, 12_000),
            projectFile,
            projectText: await readIf(projectFile, 12_000),
            globalRefFile: `${home}/.claude/CLAUDE.md`,
            globalRefText: await readIf(`${home}/.claude/CLAUDE.md`, 12_000),
            projectRefFile: `${cwd}/CLAUDE.md`,
            projectRefText: await readIf(`${cwd}/CLAUDE.md`, 12_000),
            skills,
          })

          const reply = await $.model.complete({ model: 'opus', system: SYSTEM, prompt, maxTokens: 4000, timeoutMs: 180_000 })
          if (!reply.isAnswered) throw new Error(`model gave no answer (${reply.reason})`)

          const found = toSuggestions(reply.text, globalFile, projectFile, skills)
          await update($, suggestions, () => found)
          await update($, phase, () => 'ready')
        } catch (err) {
          await update($, error, () => errText(err))
          await update($, phase, () => 'error')
        } finally {
          isRunning = false
        }
      })()
    })

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const p = await read($, pending)
    const ph = await read($, phase)
    const open = (await read($, suggestions)).filter(x => x.status === 'open').length
    const { Box, Text, Button } = $.ui.resolve(e)
    let mine
    if (ph === 'thinking') {
      mine = <Text color="warning">● 復盤中…</Text>
    } else if (p !== null) {
      mine = (
        <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Text color="warning" weight="semibold">
              ● 偵測到糾正
            </Text>
            <Text wrap="truncate-end">「{p.text}」</Text>
          </Box>
          <Text weight="semibold">要不要針對這次進行復盤？</Text>
          <Box flexDirection="row" gap={1}>
            <Button
              key="retro:yes"
              variant="primary"
              label="要"
              onPress={async () => {
                await update($, pending, () => null)
                await update($, phase, () => 'thinking')
              }}
            />
            <Button key="retro:no" label="先不要" onPress={() => update($, pending, () => null)} />
          </Box>
        </Box>
      )
    } else if (ph === 'ready' && open > 0) {
      mine = (
        <Box flexDirection="row" gap={1}>
          <Text color="warning">●</Text>
          <Text>復盤完成：{open} 條建議待處理</Text>
          <Button key="retro:show" plain label="查看" onPress={() => $.ui.open({ id: PANE, title: '復盤' })} />
        </Box>
      )
    }

    if (mine === undefined) return below
    return below ? (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    ) : (
      mine
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const ph = await read($, phase)
    const list = await read($, suggestions)

    if (ph === 'thinking') return <Text dimColor>正在讀取糾正紀錄、AGENTS.md 與 Skills，產生建議中…</Text>
    if (ph === 'error') return <Text color="error">復盤失敗：{await read($, error)}</Text>
    if (list.length === 0) return <Text dimColor>這次沒有足夠證據提出修改建議。</Text>

    const setOne = (id: string, patch: Partial<Suggestion>) =>
      update($, suggestions, l => l.map(x => (x.id === id ? { ...x, ...patch } : x)))
    const apply = async (sug: Suggestion) => {
      try {
        const old = (await $.fs.exists(sug.file)) ? String(await $.fs.read(sug.file)) : ''
        const sep = old === '' ? '' : old.endsWith('\n') ? '\n' : '\n\n'
        await $.fs.write(sug.file, `${old}${sep}${sug.append}\n`)
        await setOne(sug.id, { status: 'applied', isExpanded: false })
      } catch (err) {
        await setOne(sug.id, { status: 'failed', note: errText(err) })
      }
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>共 {list.length} 條建議，按「套用」才會改檔案。</Text>
        {list.map((sug, i) => (
          <Box key={`sug:${sug.id}`} flexDirection="column">
            <Text weight="bold">
              {i + 1}. [{sug.kind}] {sug.title}
            </Text>
            <Text dimColor>{sug.why}</Text>
            {sug.evidence.length > 0 && <Text dimColor>證據：{sug.evidence.map(q => `「${q}」`).join('')}</Text>}
            <Text dimColor>加到檔尾：{sug.file}</Text>
            {sug.isExpanded && <Code format="diff" path={sug.file} source={asDiff(sug.append)} />}
            {sug.status === 'open' ? (
              <Box flexDirection="row" gap={1}>
                <Button key={`apply:${sug.id}`} variant="primary" label="套用" onPress={() => apply(sug)} />
                <Button key={`skip:${sug.id}`} label="略過" onPress={() => setOne(sug.id, { status: 'skipped' })} />
                <Button
                  key={`preview:${sug.id}`}
                  label={sug.isExpanded ? '收起' : '預覽改動'}
                  onPress={() => setOne(sug.id, { isExpanded: !sug.isExpanded })}
                />
              </Box>
            ) : sug.status === 'applied' ? (
              <Text color="success">✓ 已套用</Text>
            ) : sug.status === 'skipped' ? (
              <Text dimColor>已略過</Text>
            ) : (
              <Text color="error">套用失敗：{sug.note ?? ''}</Text>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
