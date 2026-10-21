## progress-bars 規格（不可違反）
- 任何任務列都只能由使用者按 `×` 移除。不准有自動消失、筆數上限擠掉、過期隱藏等機制。
- 執行中且有預估時間時，顯示 `經過時間 / ~預估剩餘`，例如 `3m / ~25m`。沒有預估時只顯示經過時間。
- 已完成或失敗時，持續顯示總耗時。
- 剛啟動、還沒有根據的時候，不要顯示預估時間。

## 發佈與驗證
- plugin 是從 GitHub `LiamTsai/Skill` 安裝的。改完依序做：
  1. 把 `<plugin>/.claude-plugin/plugin.json` 的 `version` 往上升。版本沒變，`plugin update` 會說「已是最新版本」，不會更新。
  2. commit、push。
  3. 執行 `claude plugin marketplace update liamtsai-skill`，更新本機的 repo 副本。
  4. 執行 `claude plugin update <plugin>@liamtsai-skill`。
- 回報「已生效」之前，要先確認已安裝版本的檔案內容包含這次改動。沒有確認過，就只能說「已 commit，尚未部署」。
