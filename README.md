<p align="center">
  <img src="assets/logo.svg" width="84" height="84" alt="Token Meter Logo" />
</p>

<h1 align="center">Antigravity Token Meter</h1>

<p align="center">
  Exact daily token usage, cache hit rates, top conversations, and official Google Gemini API cost analytics for <strong>Google Antigravity</strong> — with automatic lifecycle logging, a live side-pane UI dashboard, and chat query skills.
</p>

<p align="center">
  English | <a href="./README.zh-CN.md">简体中文</a> | <a href="./CHANGELOG.md">Changelog</a>
</p>

---

## Why Token Meter?

- **Exact Metrics (Not Estimates)**: Reads step-level `input_tokens`, `cache_read_tokens` (disjoint from uncached input), and `output_tokens` directly from Antigravity's local `transcript.jsonl` files across Antigravity 2.0, CLI, and IDE.
- **Zero Dependencies & 100% Local**: Pure Node.js ESM (`>=22`). No `npm install`, no external analytics, no telemetry — all data stays on your machine under `~/.gemini/token-meter/`.
- **Automatic Persistent Ledger**: A lightweight `Stop` lifecycle hook incrementally appends completed steps to monthly NDJSON files (`~/.gemini/token-meter/events/YYYY-MM.jsonl`). Historical stats survive even if old transcripts are later cleaned up.
- **Live Side-Pane Dashboard**: Native Antigravity Auxiliary Pane UI synced automatically to your light/dark theme, with interactive SVG charts, model distribution, searchable/sortable sessions (click to jump straight to any chat), `USD $` / `CNY ¥` toggle, and one-click CSV export.
- **Official Google Gemini API Pricing**: Built-in Paid-Tier Global rate card supporting 95% implicit cache discounts on Gemini 4, date-aware introductory → standard transitions, and `≤200K` / `>200K` long-context tiers.

---

## Installation

Clone directly into your global Antigravity plugins directory:

```bash
git clone https://github.com/NianJiuZst/antigravity-token-meter.git ~/.gemini/config/plugins/token-meter
```

Antigravity automatically discovers the plugin, activates the `Stop` hook and `token-meter` skill, and starts the side-pane dashboard sidecar (backfilling all existing local conversations on first launch).

- Open **Token Meter** from the conversation header's `+` menu (Auxiliary Pane) or ask the agent in chat: *"Show my token usage and cost for today and the past 7 days"*.
- Enable, disable, or uninstall anytime from Antigravity's **Customizations / Plugins** page.

---

## Official Pricing Table (USD / 1M Tokens)

Costs are computed per step from Google AI Studio / Gemini API Paid-Tier Global pricing (`output` includes reasoning/thinking tokens):

| Model Family | Input | Cache Read | Output | Notes |
| :--- | :---: | :---: | :---: | :--- |
| **Gemini 4 Neon** | $3.00 | $0.15 | $15.00 | Implicit caching (95% discount) |
| **Gemini 4 Hydrogen** | $1.50 | $0.075 | $7.50 | Implicit caching (95% discount) |
| **Gemini 4 Carbon** | $2.00 → $4.00 | $0.10 → $0.20 | $10.00 → $20.00 | Intro through 2026-11-30 UTC; standard from 2026-12-01 |
| **Gemini 4 Argon** | $2.00 → $4.00 | $0.10 → $0.20 | $10.00 → $20.00 | Intro through 2026-11-30 UTC; standard from 2026-12-01 |
| **Gemini 3.8 Flash** | $0.75 → $1.50 | $0.075 → $0.15 | $3.75 → $7.50 | Intro through 2026-12-31 UTC; standard from 2027-01-01 |
| **Gemini 3.1 Pro / 3 Pro** | $2.00 / $4.00 | $0.20 / $0.40 | $12.00 / $18.00 | Auto-tiered at `≤200K` vs `>200K` prompt tokens |
| **Gemini 3 Flash** | $0.50 | $0.05 | $3.00 | Standard paid tier |
| **Gemini 3.1 / 3.5 Flash-Lite** | $0.25 | $0.025 | $1.50 | Standard paid tier |
| **Gemini 2.5 Pro** | $1.25 / $2.50 | $0.125 / $0.25 | $10.00 / $15.00 | Auto-tiered at `≤200K` vs `>200K` prompt tokens |
| **Gemini 2.5 Flash** | $0.30 | $0.03 | $2.50 | Standard paid tier |
| **Gemini 2.5 Flash-Lite** | $0.10 | $0.01 | $0.40 | Standard paid tier |

> **Token Accounting Formula**
> - `Total Prompt Tokens = input_tokens + cache_read_tokens`
> - `Total Tokens = input_tokens + cache_read_tokens + output_tokens`
> - `Cache Hit Rate = cache_read_tokens / (input_tokens + cache_read_tokens)`

---

## CLI & Chat Skill Usage

You can ask Antigravity directly in natural language or run the bundled CLI:

```bash
# Last 7 days summary (auto-syncs new transcripts)
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 7

# Today / 30 days / All time (--days 0) / JSON
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 1
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 30
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 0 --json

# View built-in official rate card
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs pricing

# Switch display currency (USD or CNY)
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs set-currency CNY

# Export daily breakdown to CSV
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs export --days 30 --out usage.csv

# Full rescan & compaction (preserves archived records from deleted transcripts)
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs sync --full
```

---

## Architecture

```text
antigravity-token-meter/
├── plugin.json                        # Antigravity plugin manifest
├── hooks.json                         # Stop lifecycle hook configuration
├── hooks/record.mjs                   # Fast incremental recorder triggered on Stop
├── lib/
│   ├── pricing.mjs                    # Official Google Gemini API pricing engine
│   └── ledger.mjs                     # Lock-safe incremental scanner, NDJSON ledger & aggregator
├── skills/token-meter/
│   ├── SKILL.md                       # Agent skill instructions
│   └── scripts/query.mjs              # CLI query & CSV export tool
├── sidecars/dashboard/
│   ├── sidecar.json                   # Auxiliary Pane UI extension manifest
│   ├── main.mjs                       # SidecarApp HTTP server (/api/report, /api/sync, /api/prefs, /api/export.csv)
│   ├── index.html                     # Side-pane dashboard markup
│   ├── styles.css                     # Host theme token styling (light & dark mode)
│   └── app.js                         # Interactive SVG charts, tabs, search & session jumper
└── test/e2e.test.mjs                  # End-to-end integration test suite
```

### Persistent Data (`~/.gemini/token-meter/`)

- `events/YYYY-MM.jsonl` — Deduplicated step-level ledger partitioned by UTC month
- `cursors.json` — Incremental byte-offset cursors, inode guards, and session metadata
- `prefs.json` — Display currency preference (`USD` / `CNY`)

---

## Testing

```bash
node --test test/e2e.test.mjs
```

---

## License

[MIT](./LICENSE)
