<p align="center">
  <img src="assets/logo.svg" width="84" height="84" alt="Token Meter Logo" />
</p>

<h1 align="center">Antigravity Token Meter</h1>

<p align="center">
  专为 <strong>Google Antigravity</strong> 打造的每日 Token 消耗与官方费用统计插件 —— 支持自动增量记账、侧边栏实时可视化面板与对话内一键查询。
</p>

<p align="center">
  <a href="./README.md">English</a> | 简体中文 | <a href="./CHANGELOG.md">更新日志</a>
</p>

---

## 核心特性

- **精确数据（非估算）**：直接读取 Antigravity 本机 `transcript.jsonl` 中每一步的精确 `input_tokens`、`cache_read_tokens`（与常规输入互斥）和 `output_tokens`，自动兼容 Antigravity 2.0、CLI 与 IDE。
- **零外部依赖、100% 本地运行**：纯 Node.js ESM（`>=22`），无需 `npm install`，零数据上报，账本完全保存在本机 `~/.gemini/token-meter/`。
- **自动持久化记账**：通过 `Stop` 生命周期 Hook 在每轮对话结束后按字节偏移量毫秒级增量写入按月分区的账本（`~/.gemini/token-meter/events/YYYY-MM.jsonl`）。即使后续清理了旧会话日志，历史统计也不会丢失。
- **侧边栏实时可视化面板**：基于 Antigravity Sidecar 渲染在右侧辅助栏，自动跟随宿主浅色/深色主题：
  - **当前会话 / 本轮实时卡片**：顶部常驻可点击展开/收起的精简状态条与卡片，实时显示模型名、本轮步数、当前上下文占用与进度条、本轮输出、本轮累计输入（新增 + 读缓存 + 命中率）、总时长及当前会话 TPS，并支持切换回看历史轮次。
  - **总览**：今日/周期费用、总 Token、缓存命中率与缓存节省金额、当前会话消耗、可切换「费用 / Token 构成」的交互式 SVG 柱状图、每日明细表与一键导出 CSV。
  - **模型**：按模型展示费用占比、缓存命中率与生效的 Google 官方单价。
  - **会话**：支持全量搜索、按费用 / Token / 最近活跃排序，点击即可直接跳转回对应对话。
- **内置 Google 官方 Gemini API 实际定价**：自动处理 Gemini 4 隐式缓存 95% 折扣、Carbon / Argon / 3.8 Flash 按日期自动切档，以及 Pro 系列 `≤200K` / `>200K` 长上下文自动分档。

---

## 安装方式

直接克隆到 Antigravity 全局插件目录即可自动生效：

```bash
git clone https://github.com/NianJiuZst/antigravity-token-meter.git ~/.gemini/config/plugins/token-meter
```

克隆完成后，Antigravity 会自动发现并启用 `token-meter` 插件，首次启动时会自动回溯导入本机所有历史会话记录。

- 在对话右上角 `+` 菜单中打开 **Token Meter** 侧边栏面板，或直接在对话中询问：“今天和最近 7 天用了多少 token 和费用？”
- 随时可在 Antigravity 的 **Customizations / Plugins** 页面一键启停或卸载。

---

## Google 官方定价表（USD / 1M Tokens）

按 Google AI Studio / Gemini API Paid Tier（Global）官方价目表逐笔精确计算（Output 单价已包含 Thinking / 思考 Token）：

| 模型系列 | Input | Cache Read | Output | 官方分档规则 |
| :--- | :---: | :---: | :---: | :--- |
| **Gemini 4 Neon** | $3.00 | $0.15 | $15.00 | 隐式缓存 95% 折扣 |
| **Gemini 4 Hydrogen** | $1.50 | $0.075 | $7.50 | 隐式缓存 95% 折扣 |
| **Gemini 4 Carbon** | $2.00 → $4.00 | $0.10 → $0.20 | $10.00 → $20.00 | 2026-11-30 UTC 前首发价，12/1 起标准价 |
| **Gemini 4 Argon** | $2.00 → $4.00 | $0.10 → $0.20 | $10.00 → $20.00 | 2026-11-30 UTC 前首发价，12/1 起标准价 |
| **Gemini 3.8 Flash** | $0.75 → $1.50 | $0.075 → $0.15 | $3.75 → $7.50 | 2026-12-31 UTC 前首发价，2027-01-01 起标准价 |
| **Gemini 3.1 Pro / 3 Pro** | $2.00 / $4.00 | $0.20 / $0.40 | $12.00 / $18.00 | 按单步 Prompt `≤200K` / `>200K` 自动分档 |
| **Gemini 3 Flash** | $0.50 | $0.05 | $3.00 | 官方标准价 |
| **Gemini 3.1 / 3.5 Flash-Lite** | $0.25 | $0.025 | $1.50 | 官方标准价 |
| **Gemini 2.5 Pro** | $1.25 / $2.50 | $0.125 / $0.25 | $10.00 / $15.00 | 按单步 Prompt `≤200K` / `>200K` 自动分档 |
| **Gemini 2.5 Flash** | $0.30 | $0.03 | $2.50 | 官方标准价 |
| **Gemini 2.5 Flash-Lite** | $0.10 | $0.01 | $0.40 | 官方标准价 |

---

## 命令行与对话查询

```bash
# 查看近 7 天汇总（自动增量同步最新日志）
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 7

# 查看今日 / 近 30 天 / 全部（--days 0）
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 1
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 30
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 0

# 查看内置 Google 官方定价表
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs pricing

# 切换显示货币（USD / CNY）
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs set-currency CNY

# 导出近 30 天每日明细 CSV
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs export --days 30 --out usage.csv

# 全量重扫并压缩去重（自动保留已删除日志的历史归档）
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs sync --full
```

---

## 运行测试

```bash
node --test test/e2e.test.mjs
```

---

## 开源协议

[MIT](./LICENSE)
