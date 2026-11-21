import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Official Google Gemini API Paid-Tier (Global) pricing in USD per 1M tokens.
 * Source: https://ai.google.dev/gemini-api/docs/pricing
 *
 * - Output rates include response + internal reasoning/thinking tokens.
 * - Gemini 4 models use implicit context caching (95% discount on cache reads).
 * - Gemini 4 Carbon & Argon use introductory pricing through 2026-11-30 UTC,
 *   switching to standard pricing on 2026-12-01T00:00:00Z.
 * - Gemini 3.8 Flash uses introductory pricing through 2026-12-31 UTC,
 *   switching to standard pricing on 2027-01-01T00:00:00Z.
 * - Gemini 3.1 Pro, Gemini 3 Pro, and Gemini 2.5 Pro apply long-context
 *   pricing when total prompt tokens (input + cacheRead) exceed 200,000.
 */

const DEC_1_2026_UTC = Date.UTC(2026, 11, 1, 0, 0, 0);
const JAN_1_2027_UTC = Date.UTC(2027, 0, 1, 0, 0, 0);
const LONG_CONTEXT_THRESHOLD = 200_000;

export const OFFICIAL_PRICING_RULES = [
  {
    prefix: 'gemini-4-neon',
    family: 'Gemini 4 Neon',
    resolve: () => ({
      input: 3.0,
      cacheRead: 0.15,
      output: 15.0,
      tierNote: '官方标准价 (缓存 95% 折扣)',
    }),
  },
  {
    prefix: 'gemini-4-hydrogen',
    family: 'Gemini 4 Hydrogen',
    resolve: () => ({
      input: 1.5,
      cacheRead: 0.075,
      output: 7.5,
      tierNote: '官方标准价 (缓存 95% 折扣)',
    }),
  },
  {
    prefix: 'gemini-4-carbon',
    family: 'Gemini 4 Carbon',
    resolve: ({ ts }) =>
      ts >= DEC_1_2026_UTC
        ? { input: 4.0, cacheRead: 0.2, output: 20.0, tierNote: '官方标准价 (12/1 起)' }
        : { input: 2.0, cacheRead: 0.1, output: 10.0, tierNote: '官方首发价 (至 11/30，12/1 起 $4/$0.2/$20)' },
  },
  {
    prefix: 'gemini-4-argon',
    family: 'Gemini 4 Argon',
    resolve: ({ ts }) =>
      ts >= DEC_1_2026_UTC
        ? { input: 4.0, cacheRead: 0.2, output: 20.0, tierNote: '官方标准价 (12/1 起)' }
        : { input: 2.0, cacheRead: 0.1, output: 10.0, tierNote: '官方首发价 (至 11/30，12/1 起 $4/$0.2/$20)' },
  },
  {
    prefix: 'gemini-3.8-flash',
    family: 'Gemini 3.8 Flash',
    resolve: ({ ts }) =>
      ts >= JAN_1_2027_UTC
        ? { input: 1.5, cacheRead: 0.15, output: 7.5, tierNote: '官方标准价 (2027 起)' }
        : { input: 0.75, cacheRead: 0.075, output: 3.75, tierNote: '官方首发价 (至 12/31)' },
  },
  {
    prefix: 'gemini-3.1-pro',
    family: 'Gemini 3.1 Pro',
    resolve: ({ promptTotal }) =>
      promptTotal > LONG_CONTEXT_THRESHOLD
        ? { input: 4.0, cacheRead: 0.4, output: 18.0, tierNote: '官方长上下文价 (>200K)' }
        : { input: 2.0, cacheRead: 0.2, output: 12.0, tierNote: '官方标准价 (≤200K / >200K 分档)' },
  },
  {
    prefix: 'gemini-3-pro',
    family: 'Gemini 3 Pro',
    resolve: ({ promptTotal }) =>
      promptTotal > LONG_CONTEXT_THRESHOLD
        ? { input: 4.0, cacheRead: 0.4, output: 18.0, tierNote: '官方长上下文价 (>200K)' }
        : { input: 2.0, cacheRead: 0.2, output: 12.0, tierNote: '官方标准价 (≤200K / >200K 分档)' },
  },
  {
    prefix: 'gemini-3.1-flash-lite',
    family: 'Gemini 3.1 Flash-Lite',
    resolve: () => ({
      input: 0.25,
      cacheRead: 0.025,
      output: 1.5,
      tierNote: '官方标准价',
    }),
  },
  {
    prefix: 'gemini-3.5-flash-lite',
    family: 'Gemini 3.5 Flash-Lite',
    resolve: () => ({
      input: 0.25,
      cacheRead: 0.025,
      output: 1.5,
      tierNote: '官方标准价',
    }),
  },
  {
    prefix: 'gemini-3-flash',
    family: 'Gemini 3 Flash',
    resolve: () => ({
      input: 0.5,
      cacheRead: 0.05,
      output: 3.0,
      tierNote: '官方标准价',
    }),
  },
  {
    prefix: 'gemini-2.5-pro',
    family: 'Gemini 2.5 Pro',
    resolve: ({ promptTotal }) =>
      promptTotal > LONG_CONTEXT_THRESHOLD
        ? { input: 2.5, cacheRead: 0.25, output: 15.0, tierNote: '官方长上下文价 (>200K)' }
        : { input: 1.25, cacheRead: 0.125, output: 10.0, tierNote: '官方标准价 (≤200K / >200K 分档)' },
  },
  {
    prefix: 'gemini-2.5-flash-lite',
    family: 'Gemini 2.5 Flash-Lite',
    resolve: () => ({
      input: 0.1,
      cacheRead: 0.01,
      output: 0.4,
      tierNote: '官方标准价',
    }),
  },
  {
    prefix: 'gemini-2.5-flash',
    family: 'Gemini 2.5 Flash',
    resolve: () => ({
      input: 0.3,
      cacheRead: 0.03,
      output: 2.5,
      tierNote: '官方标准价',
    }),
  },
];

// Fallback reference rate used only for pre-Nov-19 legacy steps where Antigravity
// transcripts did not record a model name and no parent/settings model is recoverable.
export const FALLBACK_RATE = {
  input: 2.0,
  cacheRead: 0.1,
  output: 10.0,
  tierNote: '旧版日志无模型字段，按 Gemini 4 基准价估算',
};

export const DEFAULT_PREFS = {
  version: 1,
  currency: 'USD',
  cnyRate: 7.25,
};

export function getDataDir() {
  return process.env.TOKEN_METER_DATA_DIR || join(homedir(), '.gemini', 'token-meter');
}

export function getPrefsPath(dataDir = getDataDir()) {
  return join(dataDir, 'prefs.json');
}

export function loadPrefs(dataDir = getDataDir()) {
  const path = getPrefsPath(dataDir);
  if (!existsSync(path)) return { ...DEFAULT_PREFS };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    const currency = parsed?.currency === 'CNY' ? 'CNY' : 'USD';
    const cnyRate = Number(parsed?.cnyRate);
    return {
      version: 1,
      currency,
      cnyRate: Number.isFinite(cnyRate) && cnyRate > 0 ? cnyRate : DEFAULT_PREFS.cnyRate,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function prefsMtime(dataDir = getDataDir()) {
  try {
    const s = statSync(getPrefsPath(dataDir));
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'default';
  }
}

export function savePrefs(patch = {}, dataDir = getDataDir()) {
  const cur = loadPrefs(dataDir);
  const currency = patch.currency === 'CNY' ? 'CNY' : patch.currency === 'USD' ? 'USD' : cur.currency;
  const rawRate = patch.cnyRate !== undefined ? Number(patch.cnyRate) : cur.cnyRate;
  const clean = {
    version: 1,
    currency,
    cnyRate: Number.isFinite(rawRate) && rawRate > 0 ? Math.round(rawRate * 10000) / 10000 : cur.cnyRate,
  };
  mkdirSync(dataDir, { recursive: true });
  const target = getPrefsPath(dataDir);
  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
  return clean;
}

export function normalizeModel(raw) {
  if (!raw || typeof raw !== 'string') return 'unknown';
  const s = raw.trim();
  if (!s) return 'unknown';
  if (/^[a-z0-9._:/-]+$/.test(s)) return s;
  return (
    s
      .toLowerCase()
      .replace(/[()[\]]+/g, ' ')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown'
  );
}

const EFFORT_LABELS = {
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  minimal: 'Minimal',
};

export function formatModelLabel(slug) {
  const s = normalizeModel(slug);
  if (s === 'unknown') return '未记录模型 (旧版日志)';
  const parts = s.split('-');
  let effort = '';
  if (parts.length > 1 && EFFORT_LABELS[parts[parts.length - 1]]) {
    effort = EFFORT_LABELS[parts.pop()];
  }
  const head = parts
    .map((p) => {
      if (p === 'gpt') return 'GPT';
      if (/^\d/.test(p)) return p;
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(' ');
  return effort ? `${head} (${effort})` : head;
}

export function resolveModelRate(model, { ts = Date.now(), promptTotal = 0 } = {}) {
  const key = normalizeModel(model);
  let best = null;
  for (const rule of OFFICIAL_PRICING_RULES) {
    if (
      key === rule.prefix ||
      key.startsWith(`${rule.prefix}-`) ||
      key.startsWith(`${rule.prefix}.`) ||
      key.startsWith(`${rule.prefix}:`)
    ) {
      if (!best || rule.prefix.length > best.prefix.length) {
        best = rule;
      }
    }
  }
  if (best) {
    const resolved = best.resolve({ ts, promptTotal });
    return {
      input: resolved.input,
      cacheRead: resolved.cacheRead,
      output: resolved.output,
      tierNote: resolved.tierNote,
      matchType: 'official',
      matchedRule: best.prefix,
    };
  }
  return {
    ...FALLBACK_RATE,
    matchType: 'fallback',
    matchedRule: 'fallback',
  };
}

export function listOfficialRateCard(nowMs = Date.now()) {
  return OFFICIAL_PRICING_RULES.map((rule) => {
    const r = rule.resolve({ ts: nowMs, promptTotal: 0 });
    return {
      prefix: rule.prefix,
      family: rule.family,
      input: r.input,
      cacheRead: r.cacheRead,
      output: r.output,
      tierNote: r.tierNote,
    };
  });
}

export function calcCostUsd(input, cacheRead, output, rate) {
  const inTok = Math.max(0, Number(input) || 0);
  const crTok = Math.max(0, Number(cacheRead) || 0);
  const outTok = Math.max(0, Number(output) || 0);
  const inputCost = (inTok / 1e6) * rate.input;
  const cacheCost = (crTok / 1e6) * rate.cacheRead;
  const outputCost = (outTok / 1e6) * rate.output;
  const cacheSaved = (crTok / 1e6) * Math.max(0, rate.input - rate.cacheRead);
  return {
    inputCost,
    cacheCost,
    outputCost,
    total: inputCost + cacheCost + outputCost,
    cacheSaved,
  };
}

export function getContextWindow(model) {
  const key = normalizeModel(model);
  if (key.startsWith('claude-')) return 200_000;
  return 1_000_000;
}
