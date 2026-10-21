import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { SessionEntry, SessionRow, Task, TaskStatus } from '../types'

const tasks = atom({ plugin: 'progress-bars', key: 'tasks' } as const, [])
const tick = atom({ plugin: 'progress-bars', key: 'tick' } as const, 0)
const self = atom({ plugin: 'progress-bars', key: 'self' } as const, null)
const others = atom({ plugin: 'progress-bars', key: 'others' } as const, [])
const hidden = atom({ plugin: 'progress-bars', key: 'hidden' } as const, {})
const sync = atom({ plugin: 'progress-bars', key: 'sync' } as const, '')

const TOOL = 'report_progress'
const TOOL_ID = `mcp__progress-bars__${TOOL}`
const LIST_SESSIONS = 'mcp__ccd_session_mgmt__list_sessions'
const GET_SESSION = 'mcp__ccd_session_mgmt__get_session'
const OPEN_SESSION = 'mcp__ccd_window__open_session_in'

const SYNC_MS = 10_000
/** Store key of the sessions closed with ×, shared by every session: id → when */
const HIDDEN_KEY = 'hidden'

const GUIDE = `# Progress bars
The person watches a progress band above the prompt. Every request they send already has its own row there, opened when the turn starts and ticked when it ends, under the id \`current\`. When answering takes more than a couple of steps, call \`${TOOL_ID}\` with \`id: "current"\` and your honest \`percent\` done once you know the plan, then after each meaningful step with \`percent\` and, once you have a basis, \`eta_minutes\` left (the row is closed for you when the turn ends). Use a separate stable \`id\` and a short \`title\` only for work that runs beside it (a side session you started, a long build); close those with \`status: "done"\` or \`"failed"\`. Subagents you start with the Agent tool are tracked on their own. Never skip the updates on multi-step work.`

const NUDGE = `This request has a row in the person's progress band. If answering it takes any tool call, your FIRST tool call must be \`${TOOL_ID}\` with \`id: "current"\` and your \`percent\` (usually 0-10), with no \`eta_minutes\`: there is nothing to estimate from yet. After each meaningful step, update it with \`percent\` and, once a step done gives you a basis, \`eta_minutes\`. Skip it only for an answer with no tool call at all.`

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

function upsert(list: Task[], id: string, patch: Partial<Task> & { title?: string }, now: number): Task[] {
  const old = list.find(t => t.id === id)
  if (old === undefined) {
    const fresh: Task = {
      id,
      title: patch.title ?? id,
      percent: null,
      etaMinutes: null,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      ...patch,
    }
    return [...list, fresh]
  }
  return list.map(t => (t.id === id ? { ...t, ...patch, updatedAt: now } : t))
}

function minutesLeft(task: Task, now: number): number | null {
  if (task.status !== 'running' || task.etaMinutes === null) return null
  const left = task.etaMinutes - (now - task.updatedAt) / 60_000
  return Math.max(1, Math.ceil(left))
}

function since(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

/**
 * Time spent, and while running the time left: "3m / ~25m". The estimate shows
 * only from a task's second report on: the first one has nothing to go by yet.
 */
function timeText(task: Task, now: number): string {
  if (task.status !== 'running') return since(task.startedAt, task.updatedAt)
  const left = (task.reports ?? 0) >= 2 ? minutesLeft(task, now) : null
  return left === null ? since(task.startedAt, now) : `${since(task.startedAt, now)} / ~${left}m`
}

/** A tool's answer is JSON text; anything else reads as null. */
function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** One session as every band draws it: a header row, then its tasks. */
type Group = { id: string; title: string; isRunning: boolean; tasks: Task[]; canFocus: boolean; isSelf: boolean }

const newest = (list: Task[]) => Math.max(0, ...list.map(t => t.updatedAt))

/** The same order in every session: by when each session's first task started. */
const groupOrder = (g: Group) => (g.tasks.length > 0 ? Math.min(...g.tasks.map(t => t.startedAt)) : Number.MAX_SAFE_INTEGER)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description:
        'Reports progress of a task to the progress band the person watches above the prompt. Call it when a multi-step task starts, after each meaningful step, and when it ends.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable id for this task; reuse it for every update.' },
          title: { type: 'string', description: 'Short name shown in the band (a few words).' },
          percent: { type: 'number', minimum: 0, maximum: 100, description: 'Honest estimate of how much is done, 0-100.' },
          eta_minutes: { type: 'number', minimum: 0, description: 'Estimated minutes left.' },
          status: { type: 'string', enum: ['running', 'done', 'failed'], description: 'Defaults to running.' },
        },
        required: ['id'],
      },
    })

    // Every 10s: publish this session's tasks to the shared store, then read
    // every other session's from the app's session list and the store.
    let published = ''
    let publishedAt = 0
    let isSyncing = false
    let syncs = 0
    const syncOnce = async () => {
      if (isSyncing) return
      isSyncing = true
      try {
        let me = await read($, self)
        if (me === null) {
          const got = await $.tool.call({ tool: GET_SESSION, session_id: 'self' } as never).catch(() => undefined)
          const info = parseJson(got?.text) as { sessionId?: string; title?: string } | null
          me =
            info?.sessionId !== undefined
              ? { id: info.sessionId, title: info.title ?? '', isDesktop: true }
              : { id: `cli:${await $.session.id()}`, title: '', isDesktop: false }
          const found = me
          await update($, self, () => found)
        } else if (me.isDesktop && ++syncs % 6 === 0) {
          // The app names a session after its first turns; pick the name up.
          const got = await $.tool.call({ tool: GET_SESSION, session_id: 'self' } as never).catch(() => undefined)
          const title = (parseJson(got?.text) as { title?: string } | null)?.title
          if (title !== undefined && title !== me.title) {
            const renamed = { ...me, title }
            await update($, self, () => renamed)
            me = renamed
          }
        }

        const now = await $.clock.now()
        const mine = await read($, tasks)
        const snapshot = JSON.stringify(mine)
        // Every session writes the same store file, so publish again each minute
        // in case another session's write dropped this one's entry.
        if (snapshot !== published || now - publishedAt > 60_000) {
          const entry: SessionEntry = { id: me.id, title: me.title, tasks: mine, updatedAt: now }
          await $.store.set(`s:${me.id}`, entry)
          published = snapshot
          publishedAt = now
        }

        if (!me.isDesktop) return
        const listed = await $.tool.call({ tool: LIST_SESSIONS, limit: 40 } as never)
        const sessions = parseJson(listed.text)
        if (!Array.isArray(sessions)) {
          await update($, sync, () => `list_sessions: ${String(listed.text ?? listed.deny ?? '').slice(0, 200)}`)
          return
        }

        const rows: SessionRow[] = []
        for (const raw of sessions as Array<Record<string, unknown>>) {
          const id = String(raw.sessionId ?? '')
          if (id === '' || raw.isArchived === true) continue
          const entry = (await $.store.get(`s:${id}`)) as SessionEntry | undefined
          const isRunning = raw.isRunning === true
          if (!isRunning && (entry?.tasks.length ?? 0) === 0) continue
          rows.push({
            id,
            title: String(raw.title ?? entry?.title ?? id),
            isRunning,
            lastActivityAt: Date.parse(String(raw.lastActivityAt ?? '')) || now,
            tasks: entry?.tasks ?? [],
            canFocus: raw.startedBy === me.id,
          })
        }
        rows.sort((a, b) => Number(b.isRunning) - Number(a.isRunning) || b.lastActivityAt - a.lastActivityAt)
        const shown = rows
        const closed = ((await $.store.get(HIDDEN_KEY)) ?? {}) as Record<string, number>
        if (JSON.stringify(closed) !== JSON.stringify(await read($, hidden))) await update($, hidden, () => closed)
        if (JSON.stringify(shown) !== JSON.stringify(await read($, others))) await update($, others, () => shown)
        const status = `ok ${new Date(now).toISOString()} · ${sessions.length} listed · ${shown.length} shown`
        await update($, sync, () => status)
        await $.store.set(`sync:${me.id}`, status)
      } catch (err) {
        const status = `error: ${err instanceof Error ? err.message : String(err)}`
        await update($, sync, () => status)
        await $.store.set('sync:last-error', status)
      } finally {
        isSyncing = false
      }
    }
    $.clock.after(1_000, () => void syncOnce())
    $.clock.every(SYNC_MS, () => void syncOnce())

    // Redraw every 30s so the "~Nm" countdown and elapsed times move.
    $.clock.every(30_000, () => void update($, tick, n => n + 1))

    return next(e)
  })

  // The system prompt alone is not enough for the model to report, so each
  // typed request carries the reminder too.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta === true || e.text.trim() === '') return next(e)
    return next({ ...e, context: [...(e.context ?? []), NUDGE] })
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    return { sections: [...sections, { id: 'progress-bars:guide', text: GUIDE, scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'mcp__progress-bars__report_progress' }, async ($, e) => {
    let id = String(e.id ?? '').trim()
    if (id === '') return { deny: 'report_progress needs an id.' }
    if (id === 'current') {
      const open = (await read($, tasks)).filter(t => t.id.startsWith('req:') && t.status === 'running')
      id = open.sort((x, y) => y.startedAt - x.startedAt)[0]?.id ?? 'req:current'
    }

    const patch: Partial<Task> = {}
    if (typeof e.title === 'string' && e.title.trim() !== '') patch.title = e.title.trim()
    if (typeof e.percent === 'number') patch.percent = clamp(e.percent)
    if (typeof e.eta_minutes === 'number') patch.etaMinutes = Math.max(0, e.eta_minutes)
    const status = e.status as TaskStatus | undefined
    if (status === 'running' || status === 'done' || status === 'failed') patch.status = status
    if (patch.status === 'done') {
      patch.percent = 100
      patch.etaMinutes = null
    }

    const now = await $.clock.now()
    const target = id
    await update($, tasks, list => {
      const reports = (list.find(t => t.id === target)?.reports ?? 0) + 1
      return upsert(list, target, { ...patch, reports }, now)
    })

    return { result: `Progress for "${id}" recorded.` }
  })

  // Every request of the main conversation gets a row of its own.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      // Claude Code puts its own context in <system-reminder> blocks ahead of what the person typed.
      const typed = e.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      const firstLine = typed.split('\n')[0] ?? ''
      const title = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine || '回應中'
      const now = await $.clock.now()
      await update($, tasks, list => upsert(list, `req:${e.turnId}`, { title, status: 'running', startedAt: now }, now))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const id = `req:${e.turnId}`
      const isDone = e.reason === 'answer'
      const now = await $.clock.now()
      await update($, tasks, list =>
        list.map(t =>
          t.id === id && t.status === 'running'
            ? { ...t, status: isDone ? 'done' : 'failed', percent: isDone ? 100 : t.percent, etaMinutes: null, updatedAt: now }
            : t,
        ),
      )
    }
    return next(e)
  })

  // Subagents started with the Agent tool are tracked without the model's help.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const description = typeof e.description === 'string' ? e.description : 'Subagent'
    const id = `agent:${description}`
    const now = await $.clock.now()
    await update($, tasks, list => upsert(list, id, { title: description, status: 'running', startedAt: now }, now))

    const ran = await next(e)

    const end = await $.clock.now()
    if (ran.deny !== undefined || ran.isError === true) {
      await update($, tasks, list => upsert(list, id, { status: 'failed', etaMinutes: null }, end))
    } else {
      const result = ran.result as { status?: string; agentId?: string } | undefined
      if (result?.status === 'async_launched' && typeof result.agentId === 'string') {
        const agentId = result.agentId
        await update($, tasks, list => list.map(t => (t.id === id ? { ...t, agentId } : t)))
      } else {
        await update($, tasks, list => upsert(list, id, { status: 'done', percent: 100, etaMinutes: null }, end))
      }
    }

    return ran
  })

  // A background subagent finishing.
  on('classic.SubagentStop', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, tasks, list =>
      list.map(t =>
        t.agentId === e.agent_id && t.status === 'running'
          ? { ...t, status: 'done', percent: 100, etaMinutes: null, updatedAt: now }
          : t,
      ),
    )
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, tasks, () => [])
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const me = await read($, self)
    const mine = await read($, tasks)
    const rest = await read($, others)
    const closedAt = await read($, hidden)
    await read($, tick)
    const below = await next(e)
    if (e.props.hasSurvey) return below

    // Every session draws the same groups in the same order: this session is
    // one of them, built from its own tasks, the rest from the shared store.
    const meId = me?.id ?? 'self'
    const groups: Group[] = [
      { id: meId, title: me?.title || '這個 session', isRunning: e.props.isWorking, tasks: mine, canFocus: false, isSelf: true },
      ...rest.map(s => ({ ...s, isSelf: false })),
    ]
    groups.sort((a, b) => groupOrder(a) - groupOrder(b) || a.id.localeCompare(b.id))

    const shown: Array<{ group: Group; tasks: Task[] }> = []
    for (const g of groups) {
      // × on a session or a task hides it everywhere until it reports something newer.
      const at = closedAt[g.id]
      if (at !== undefined && newest(g.tasks) <= at) continue
      const visible = g.tasks
        .filter(t => !(closedAt[`${g.id}/${t.id}`] !== undefined && t.updatedAt <= (closedAt[`${g.id}/${t.id}`] ?? 0)))
        .sort((a, b) => a.startedAt - b.startedAt)
      if (visible.length === 0 && !g.isRunning) continue
      shown.push({ group: g, tasks: visible })
    }
    if (shown.length === 0) return below

    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = Math.max(40, e.props.bodyColumns)
    const indent = 2
    const titleW = Math.min(34, Math.floor(cols * 0.3))
    // indent 2 + icon 2 + gaps 5 + percent 4 + time 12 + close 1
    const barW = Math.max(8, cols - titleW - indent - 24 - 2)

    const close = async (key: string) => {
      const closed = { ...closedAt, [key]: await $.clock.now() }
      await update($, hidden, () => closed)
      const stored = ((await $.store.get(HIDDEN_KEY).catch(() => undefined)) ?? {}) as Record<string, number>
      await $.store.set(HIDDEN_KEY, { ...stored, ...closed }).catch(() => undefined)
    }

    const focus = async (g: Group) => {
      if (g.isSelf) return
      if (!g.canFocus) {
        $.ui.toast(`App 只允許切換到這個 session 開出的 session，請從側邊欄點開「${g.title}」`)
        return
      }
      const r = await $.tool.call({ tool: OPEN_SESSION, session_id: g.id, target: 'focus' } as never).catch(
        (err: unknown) => ({ deny: err instanceof Error ? err.message : String(err) }),
      )
      if (r.deny !== undefined || r.isError === true) $.ui.toast(`無法切換到「${g.title}」：${r.deny ?? r.text ?? ''}`)
    }

    return (
      <Box flexDirection="column">
        {below}
        {shown.map(({ group: g, tasks: list }) => (
          <Box key={`group:${g.id}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Box flexGrow={1}>
                <Button key={`open:${g.id}`} plain onPress={() => focus(g)}>
                  <Text weight="semibold" wrap="truncate-end">
                    {g.title}
                  </Text>
                  {list.length === 0 ? <Text dimColor>  執行中</Text> : ''}
                </Button>
              </Box>
              <Button key={`close:${g.id}`} plain label="×" onPress={() => close(g.id)} />
            </Box>
            {list.map(t => {
              const color = t.status === 'done' ? 'success' : t.status === 'failed' ? 'error' : 'claude'
              const icon = t.status === 'done' ? '✓' : t.status === 'failed' ? '✗' : '●'
              const filled = t.percent === null ? 0 : Math.round((barW * t.percent) / 100)
              return (
                <Box key={`row:${g.id}/${t.id}`} flexDirection="row" gap={1} marginLeft={indent}>
                  <Box width={2}>
                    <Text color={color}>{icon}</Text>
                  </Box>
                  <Box width={titleW}>
                    <Text wrap="truncate-end" dimColor={t.status === 'done'}>
                      {t.title}
                    </Text>
                  </Box>
                  <Box width={barW}>
                    <Text mono>
                      <Text color={color} dimColor={t.status === 'done'}>
                        {'━'.repeat(filled)}
                      </Text>
                      <Text color="subtle">{'━'.repeat(barW - filled)}</Text>
                    </Text>
                  </Box>
                  <Box width={4} justifyContent="flex-end">
                    <Text tabular weight="semibold">
                      {t.percent === null ? '…' : `${t.percent}%`}
                    </Text>
                  </Box>
                  <Box width={12}>
                    <Text dimColor tabular>
                      {timeText(t, now)}
                    </Text>
                  </Box>
                  <Button key={`close:${g.id}/${t.id}`} plain label="×" onPress={() => close(`${g.id}/${t.id}`)} />
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  })
}
