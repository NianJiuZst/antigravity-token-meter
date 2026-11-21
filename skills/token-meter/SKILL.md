---
name: token-meter
description: Query daily Antigravity token usage, cache hit rates, top conversations, and costs calculated using official Google Gemini API pricing, or export CSV reports. Use whenever the user asks how many tokens or how much cost they used today, this week, this month, by model, or by conversation, or wants to view official rates or open the Token Meter dashboard.
---

# Token Meter

Query the user's daily Antigravity token usage and costs calculated with official Google Gemini API Paid-Tier pricing.

## Quick Commands

```bash
# Default 7-day summary (auto-syncs new transcript steps first)
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 7

# Today only / 30 days / All time (--days 0)
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 1
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 30
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 0

# Machine-readable JSON
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs summary --days 14 --json

# Sync / Full rescan & compaction
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs sync
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs sync --full

# View built-in official Google Gemini API rate card
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs pricing

# Switch display currency (USD / CNY)
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs set-currency CNY

# Export daily report to CSV
node ~/.gemini/config/plugins/token-meter/skills/token-meter/scripts/query.mjs export --days 30
```

## Notes for Reporting

- `input_tokens` and `cache_read_tokens` in Antigravity transcripts are **disjoint**:
  - Total Prompt Tokens = `input_tokens + cache_read_tokens`
  - Total Tokens = `input_tokens + cache_read_tokens + output_tokens`
  - Cache Hit Rate = `cache_read_tokens / (input_tokens + cache_read_tokens)`
- Pricing uses built-in official Google Gemini API Paid-Tier rates (including date-aware introductory/standard transitions and `>200K` long-context tiers where applicable).
- If the side-pane UI is running, offer a one-click pill `[Token Meter](sidecar://token-meter/dashboard/)` to open the live visual panel.
