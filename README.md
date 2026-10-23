# Skill

Claude Code 的 mod（function-hook plugin）合集，每個資料夾是一個獨立的 plugin。

| 資料夾 | 做什麼 |
| --- | --- |
| [`progress-bars/`](progress-bars/) | 輸入框上方的進度條：每個需求、每個 session 一列，顯示百分比、已用時間與預估剩餘時間 |
| [`retro-me/`](retro-me/) | 偵測你在糾正 Claude 時主動詢問復盤，產生 AGENTS.md / Skill 修改建議，一鍵套用 |

## progress-bars

在輸入框上方顯示進度條，一眼看到哪些在跑、哪些已完成。

```
專案 UI 重新設計                                                                ×
  ● Hades 風格 UI 改作      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  72%  12m / ~5m   ×
  ✓ 調整色票                ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100%  8m          ×
Fix upload                                                                      ×
  ● localStorage 上傳       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  51%  3m / ~15m   ×
```

- 你送出的每個需求自動一列；Claude 透過 `report_progress` 工具回報百分比，有了根據才加上預估時間。子代理與並行工作（子 session、長時間建置）也各自一列。
- 依 session 分組；在 Claude Code Desktop 裡，所有 session 看到的是同一份進度，點 session 標題可以切過去。
- 執行中顯示「已用時間 / ~預估剩餘」（例如 `3m / ~25m`），完成後顯示總用時。
- 列不會自動消失，只有按 `×` 才會隱藏。

完整說明見 [progress-bars/README.md](progress-bars/README.md)。

## RetroMe

偵測到你在糾正 Claude 時，主動問你要不要「復盤」，把結論變成 AGENTS.md 或 Skill 的修改建議。

```
● 偵測到糾正 「不是這樣，回報前要先自己測過」
要不要針對這次進行復盤？  [要]  [先不要]
```

- 你送出訊息時，背景用 haiku 判斷是不是在糾正 Claude 剛才做的事，不擋送出。
- 按「要」後用 opus 讀累積的糾正紀錄、最近的對話、全域與專案 `AGENTS.md`、`~/.claude/skills`，提出最多 3 條建議，每條附理由與你說過的原話當證據。
- 每條建議可以「預覽改動」（diff）、「套用」或「略過」。只有按「套用」才會寫檔，而且只加在檔尾。
- `/retro` 可以手動叫出同一個詢問。

完整說明見 [retro-me/README.md](retro-me/README.md)。

## 安裝

在終端機的 Claude Code 提示字元輸入（要哪個裝哪個）：

```
/plugin install progress-bars --marketplace LiamTsai/Skill
/plugin install retro-me --marketplace LiamTsai/Skill
```

第一次會問 `Add marketplace?`，按 `y`，再選安裝範圍（建議 user，所有專案都生效）。

從 shell：

```
claude plugin install progress-bars --marketplace LiamTsai/Skill
claude plugin install retro-me --marketplace LiamTsai/Skill
```

在 Claude Code Desktop（`/plugin` 在那裡不能用）：點輸入框旁的 **+** → **Plugins** → **Add marketplace**，輸入 `LiamTsai/Skill`，再 **Add plugin**。

裝好之後，新開的 session 就會載入。

## 更新與移除

```
claude plugin update progress-bars@liamtsai-skill
claude plugin uninstall progress-bars@liamtsai-skill
```

`retro-me` 同理。

## 需求

- Claude Code 2.1.299 以上（function hooks 仍是 early access，API 可能隨版本變動）
- `progress-bars` 的「所有 session」與點擊切換只在 Claude Code Desktop 有效；終端機裡只顯示當前 session 的任務

## 開發

```
claude plugin validate ./progress-bars
claude plugin test ./progress-bars
```

`retro-me` 同理。

## 授權

[MIT](LICENSE)
