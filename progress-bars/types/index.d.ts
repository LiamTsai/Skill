export type TaskStatus = 'running' | 'done' | 'failed'

export type Task = {
  id: string
  title: string
  /** 0..100, or null when nothing reported one yet (a subagent) */
  percent: number | null
  /** Minutes left as last reported, counted down from `updatedAt` */
  etaMinutes: number | null
  status: TaskStatus
  startedAt: number
  updatedAt: number
  /** A background subagent's id, to mark it done when it stops */
  agentId?: string
}

/** What each session publishes to the shared store under `s:<sessionId>` */
export type SessionEntry = { id: string; title: string; tasks: Task[]; updatedAt: number }

/** Another session as the band draws it */
export type SessionRow = {
  id: string
  title: string
  isRunning: boolean
  lastActivityAt: number
  tasks: Task[]
  /** The app lets this session switch to it (it started that session) */
  canFocus: boolean
}

export type SelfInfo = { id: string; title: string; isDesktop: boolean }

declare module 'claude-code' {
  interface PluginState {
    'progress-bars': {
      tasks: Task[]
      tick: number
      self: SelfInfo | null
      others: SessionRow[]
      /** Other sessions closed with ×, by id: when (shared through the store) */
      hidden: Record<string, number>
      sync: string
    }
  }
}
