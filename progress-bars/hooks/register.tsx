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
The person watches a progress band above the prompt. Every request they send already has its own row there, opened when the turn starts and ticked when it ends, under the id \`current\`. When answering takes more than a couple of steps, call \`${TOOL_ID}\` with \`id: "current"\`, your honest \`percent\` done and \`eta_minutes\` left: once you know the plan, then after each meaningful step (the row is closed for you when the turn ends). Use a separate stable \`id\` and a short \`title\` only for work that runs beside it (a side session you started, a long build); close those with \`status: "done"\` or \`"failed"\`. Subagents you start with the Agent tool are tracked on their own. Never skip the updates on multi-step work.`

const NUDGE = `This request has a row in the person's progress band. If answering it takes any tool call, your FIRST tool call must be \`${TOOL_ID}\` with \`id: "current"\`, your \`percent\` (usually 0-10) and \`eta_minutes\`; then update it after each meaningful step. Skip it only for an answer with no tool call at all.`

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

/** Time spent, and while running the reported time left: "3m / ~25m", or "3m / ~?" before any estimate. */
function timeText(task: Task, now: number): string {
  if (task.status !== 'running') return since(task.startedAt, task.updatedAt)
  const left = minutesLeft(task, now)
  return `${since(task.startedAt, now)} / ${left === null ? '~?' : `~${left}m`}`
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

/** The task a session's row stands for: its newest running one, else its newest. */
function headTask(list: Task[]): Task | undefined {
  const running = list.filter(t => t.status === 'running')
  const pool = running.length > 0 ? running : list
  return [...pool].sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

type Line = {
  key: string
  status: TaskStatus | 'idle'
  title: string
  percent: number | null
  eta: string
  /** Another session: pressing the title switches to it */
  session?: SessionRow
}

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
    await update($, tasks, list => upsert(list, id, patch, now))

    return { result: `Progress for "${id}" recorded.` }
  })

  // Every request of the main conversation gets a row of its own.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const firstLine = e.text.trim().split('\n')[0] ?? ''
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
    const mine = await read($, tasks)
    const rest = await read($, others)
    const closedAt = await read($, hidden)
    await read($, tick)
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const now = await $.clock.now()
    const lines: Line[] = []
    for (const t of mine) {
      lines.push({
        key: t.id,
        status: t.status,
        title: t.title,
        percent: t.percent,
        eta: timeText(t, now),
      })
    }
    for (const s of rest) {
      // Closed with ×: back only once that session reports something newer.
      const at = closedAt[s.id]
      if (at !== undefined && Math.max(0, ...s.tasks.map(t => t.updatedAt)) <= at) continue
      const head = headTask(s.tasks)
      const allDone = s.tasks.length > 0 && s.tasks.every(t => t.status === 'done')
      const status: Line['status'] =
        head?.status === 'running' || (s.isRunning && head === undefined)
          ? 'running'
          : head?.status === 'failed'
            ? 'failed'
            : allDone
              ? 'done'
              : s.isRunning
                ? 'running'
                : 'idle'
      lines.push({
        key: s.id,
        status,
        title: head !== undefined && head.status === 'running' ? `${s.title} · ${head.title}` : s.title,
        percent: allDone ? 100 : head?.status === 'running' ? head.percent : null,
        eta: head !== undefined ? timeText(head, now) : status === 'running' ? '執行中' : '',
        session: s,
      })
    }
    if (lines.length === 0) return below

    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = Math.max(40, e.props.bodyColumns)
    const titleW = Math.min(34, Math.floor(cols * 0.32))
    // icon 2 + gaps 5 + percent 4 + time 12 + close 1
    const barW = Math.max(8, cols - titleW - 24 - 2)

    const focus = async (s: SessionRow) => {
      if (!s.canFocus) {
        $.ui.toast(`App 只允許切換到這個 session 開出的 session，請從側邊欄點開「${s.title}」`)
        return
      }
      const r = await $.tool.call({ tool: OPEN_SESSION, session_id: s.id, target: 'focus' } as never).catch(
        (err: unknown) => ({ deny: err instanceof Error ? err.message : String(err) }),
      )
      if (r.deny !== undefined || r.isError === true) $.ui.toast(`無法切換到「${s.title}」：${r.deny ?? r.text ?? ''}`)
    }

    return (
      <Box flexDirection="column">
        {below}
        {lines.map(l => {
          const color = l.status === 'done' ? 'success' : l.status === 'failed' ? 'error' : l.status === 'idle' ? 'subtle' : 'claude'
          const icon = l.status === 'done' ? '✓' : l.status === 'failed' ? '✗' : l.status === 'idle' ? '○' : '●'
          const filled = l.percent === null ? 0 : Math.round((barW * l.percent) / 100)
          const session = l.session

          return (
            <Box key={`row:${l.key}`} flexDirection="row" gap={1}>
              <Box width={2}>
                <Text color={color}>{icon}</Text>
              </Box>
              <Box width={titleW}>
                {session === undefined ? (
                  <Text wrap="truncate-end" dimColor={l.status === 'done'}>
                    {l.title}
                  </Text>
                ) : (
                  <Button key={`open:${l.key}`} plain onPress={() => focus(session)}>
                    <Text wrap="truncate-end" dimColor={l.status === 'done' || l.status === 'idle'}>
                      {l.title}
                    </Text>
                  </Button>
                )}
              </Box>
              <Box width={barW}>
                <Text mono>
                  <Text color={color} dimColor={l.status === 'done'}>
                    {'━'.repeat(filled)}
                  </Text>
                  <Text color="subtle">{'━'.repeat(barW - filled)}</Text>
                </Text>
              </Box>
              <Box width={4} justifyContent="flex-end">
                <Text tabular weight="semibold">
                  {l.percent === null ? '…' : `${l.percent}%`}
                </Text>
              </Box>
              <Box width={12}>
                <Text dimColor tabular>
                  {l.eta}
                </Text>
              </Box>
              <Button
                key={`close:${l.key}`}
                plain
                label="×"
                onPress={async () => {
                  if (session === undefined) await update($, tasks, list => list.filter(x => x.id !== l.key))
                  else {
                    const now = await $.clock.now()
                    const closed = { ...(((await $.store.get(HIDDEN_KEY)) ?? {}) as Record<string, number>), [l.key]: now }
                    await $.store.set(HIDDEN_KEY, closed)
                    await update($, hidden, () => closed)
                  }
                }}
              />
            </Box>
          )
        })}
      </Box>
    )
  })
}
