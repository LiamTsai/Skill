# Skill

Claude Code 的 mod（function-hook plugin）合集，每個資料夾是一個獨立的 plugin。

| 資料夾 | 做什麼 |
| --- | --- |
| [`progress-bars/`](progress-bars/) | 輸入框上方的進度條：每個需求、每個 session 一列，顯示百分比、已用時間與預估剩餘時間 |
| [`retro/`](retro/) | 偵測你在糾正 Claude 時主動詢問復盤，產生 CLAUDE.md / Skill 修改建議，一鍵套用 |

## 安裝

在終端機的 Claude Code 提示字元輸入（要哪個裝哪個）：

```
/plugin install progress-bars --marketplace LiamTsai/Skill
/plugin install retro --marketplace LiamTsai/Skill
```

第一次會問 `Add marketplace?`，按 `y`，再選安裝範圍（建議 user，所有專案都生效）。

從 shell：

```
claude plugin install progress-bars --marketplace LiamTsai/Skill
claude plugin install retro --marketplace LiamTsai/Skill
```

在 Claude Code Desktop（`/plugin` 在那裡不能用）：點輸入框旁的 **+** → **Plugins** → **Add marketplace**，輸入 `LiamTsai/Skill`，再 **Add plugin**。

裝好之後，新開的 session 就會載入。

## 更新與移除

```
claude plugin update progress-bars@liamtsai-skill
claude plugin uninstall progress-bars@liamtsai-skill
```

`retro` 同理。

## 需求

- Claude Code 2.1.299 以上（function hooks 仍是 early access，API 可能隨版本變動）
- `progress-bars` 的「所有 session」與點擊切換只在 Claude Code Desktop 有效；終端機裡只顯示當前 session 的任務

## 開發

```
claude plugin validate ./progress-bars
claude plugin test ./progress-bars
```

`retro` 同理。

## 授權

[MIT](LICENSE)
