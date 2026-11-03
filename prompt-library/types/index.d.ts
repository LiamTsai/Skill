export type SavedPrompt = {
  id: string
  name: string
  text: string
  /** The project folder the prompt was saved in */
  cwd: string
  savedAt: number
  updatedAt: number
}

/** What the edit pane holds: a new prompt (`id` null) or an edit of a saved one */
export type Draft = { id: string | null; name: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-library': {
      prompts: Shaped<SavedPrompt[]>
      draft: Draft | null
      lastSent: string
      isHereOnly: boolean
      /** What the library's search field holds */
      query: string
      /** The id whose 刪除 was pressed once and waits for 確定 */
      deleting: string | null
    }
  }
}
