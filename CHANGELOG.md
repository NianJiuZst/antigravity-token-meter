# Changelog / 更新日志

All notable changes to **Antigravity Token Meter** are documented in this file.

---

## [1.1.0] - 2026-11-22

### English
- **Official Google Gemini API Pricing**: Replaced editable custom pricing with built-in Google Gemini API Paid-Tier Global rates (including 95% implicit cache-read discounts on Gemini 4, date-aware introductory → standard transitions for Gemini 4 Carbon/Argon and Gemini 3.8 Flash, and `≤200K` / `>200K` long-context tiers for Pro models).
- **Streamlined Side-Pane Dashboard**: Focused the UI into three tabs (**Overview**, **Models**, **Sessions**) with live `USD $` / `CNY ¥` switching and CSV export.
- **Legacy Subagent Model Attribution**: Added parent-conversation inheritance (`sender=<parentConvId>`) to recover model attribution for older subagent sessions whose transcripts omitted the `model` field.
- **Cross-Platform Lifecycle Hook**: Updated `hooks.json` to invoke `node ./hooks/record.mjs` directly for macOS, Linux, and Windows compatibility.
- **Reliability & Timezone Hardening**: Added PID-verified exclusive lockfiles, inode/truncation-safe incremental cursor recovery, DST-aware IANA timezone bucketing, midnight ETag invalidation, un-truncated session search/sort, and un-truncated all-time CSV exports.

### 中文
- **内置 Google 官方 Gemini API 实际定价**：移除自定义单价编辑板块，内置 Google AI Studio / Gemini API 官方付费版定价（含 Gemini 4 隐式缓存 95% 折扣、Carbon/Argon 与 3.8 Flash 按日期自动切档、Pro 系列 `≤200K` / `>200K` 长上下文自动分档）。
- **精简侧边栏可视化面板**：聚焦 **总览 / 模型 / 会话** 三大视图，保留顶部 `USD $` / `CNY ¥` 货币切换与一键 CSV 导出。
- **旧版子 Agent 模型归属追踪**：新增基于 `sender=<父会话ID>` 的父会话模型继承解析，自动补齐早期未写 `model` 字段的子 Agent 历史记录。
- **跨平台 Hook 入口**：`hooks.json` 调整为跨平台 `node ./hooks/record.mjs`，兼容 macOS、Linux 与 Windows。
- **并发与边界加固**：引入带 PID 校验的独占文件锁、inode/缩容安全增量游标恢复、支持夏令时的 IANA 时区归日、跨零点 ETag 失效、全量会话搜索排序以及长跨度不截断 CSV 导出。

---

## [1.0.0] - 2026-11-22

### English
- Initial release of **Token Meter** for Google Antigravity: `Stop` lifecycle hook incremental recorder, persistent monthly NDJSON ledger (`~/.gemini/token-meter/`), sidecar-backed Auxiliary Pane visual dashboard, and chat query skill + CLI.

### 中文
- 首个版本发布：包含 `Stop` 生命周期 Hook 自动增量记账、按月分区持久化账本（`~/.gemini/token-meter/`）、Antigravity 右侧辅助栏可视化面板（Sidecar Web UI）及对话查询 Skill / CLI 工具。
