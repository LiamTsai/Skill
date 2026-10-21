export type Correction = { text: string; assistant: string; cwd: string; at: number }

export type SuggestionStatus = 'open' | 'applied' | 'skipped' | 'failed'

export type Suggestion = {
  id: string
  /** Label shown in brackets: "CLAUDE.md 規則", "專案 CLAUDE.md", "Skill: <name>" */
  kind: string
  title: string
  why: string
  evidence: string[]
  /** Absolute path of the file the text is appended to */
  file: string
  append: string
  status: SuggestionStatus
  isExpanded: boolean
  note?: string
}

export type RetroPhase = 'idle' | 'thinking' | 'ready' | 'error'

declare module 'claude-code' {
  interface PluginState {
    retro: {
      pending: Correction | null
      phase: RetroPhase
      error: string
      suggestions: Suggestion[]
    }
  }
}
