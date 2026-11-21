#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { buildReport, exportDailyCsv, syncAllTranscripts } from '../../../lib/ledger.mjs';
import {
  getDataDir,
  listOfficialRateCard,
  loadPrefs,
  savePrefs,
} from '../../../lib/pricing.mjs';

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function fmtNum(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

function fmtMoney(usd, prefs) {
  const isCny = prefs.currency === 'CNY';
  const sym = isCny ? '¥' : '$';
  const val = (Number(usd) || 0) * (isCny ? prefs.cnyRate : 1);
  if (val >= 1) return `${sym}${val.toFixed(2)}`;
  if (val >= 0.01) return `${sym}${val.toFixed(3)}`;
  return `${sym}${val.toFixed(4)}`;
}

function fmtPct(ratio) {
  return `${((Number(ratio) || 0) * 100).toFixed(1)}%`;
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cols) => cols.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

function cmdSummary(flags) {
  const dataDir = getDataDir();
  if (!flags['no-sync']) {
    syncAllTranscripts({ dataDir });
  }
  const days = flags.days !== undefined ? Number(flags.days) : 7;
  const prefs = loadPrefs(dataDir);
  const report = buildReport({
    dataDir,
    rangeDays: Number.isFinite(days) ? days : 7,
    activeConvId: flags.conv || '',
    prefs,
  });

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const label = report.rangeDays === 0 ? 'All Time' : report.rangeDays === 1 ? 'Today' : `Last ${report.rangeDays} Days`;
  console.log(`=== Token Meter (${label}, ${report.todayDate}, ${report.timeZone}) ===\n`);

  console.log(
    `Today (${report.todayDate}): ${fmtCompact(report.today.total)} tokens (${report.today.steps} steps) | ` +
      `In ${fmtCompact(report.today.input)} · Cache ${fmtCompact(report.today.cacheRead)} (${fmtPct(report.today.cacheHitRate)}) · Out ${fmtCompact(report.today.output)} | ` +
      `Cost ${fmtMoney(report.today.costUsd, prefs)} (saved ${fmtMoney(report.today.cacheSavedUsd, prefs)})`,
  );
  console.log(
    `Period (${label}): ${fmtCompact(report.period.total)} tokens (${report.period.steps} steps, ${report.period.activeDays} active days) | ` +
      `Cache ${fmtPct(report.period.cacheHitRate)} | Cost ${fmtMoney(report.period.costUsd, prefs)} ` +
      `(avg ${fmtMoney(report.period.avgDailyCostUsd, prefs)}/active day)`,
  );
  console.log(
    `All Time: ${fmtCompact(report.allTime.total)} tokens across ${report.allTime.totalSessions} sessions (${fmtNum(report.allTime.totalEvents)} steps) | ` +
      `Cost ${fmtMoney(report.allTime.costUsd, prefs)}`,
  );

  console.log('\n--- Daily Breakdown ---');
  const activeDaily = [...report.daily].reverse().filter((d) => d.steps > 0 || report.rangeDays <= 14);
  printTable(
    ['Date', 'Steps', 'Input', 'Cache Read', 'Output', 'Cache %', `Cost (${prefs.currency})`],
    activeDaily.map((d) => [
      d.date,
      fmtNum(d.steps),
      fmtCompact(d.input),
      fmtCompact(d.cacheRead),
      fmtCompact(d.output),
      fmtPct(d.cacheHitRate),
      fmtMoney(d.costUsd, prefs),
    ]),
  );

  if (report.models.length > 0) {
    console.log('\n--- By Model (Google Official Gemini API Pricing) ---');
    printTable(
      ['Model', 'Steps', 'Input', 'Cache Read', 'Output', 'Rate ($/1M)', `Cost (${prefs.currency})`, 'Share'],
      report.models.map((m) => [
        m.model,
        fmtNum(m.steps),
        fmtCompact(m.input),
        fmtCompact(m.cacheRead),
        fmtCompact(m.output),
        `$${m.rate.input}/$${m.rate.cacheRead}/$${m.rate.output}`,
        fmtMoney(m.costUsd, prefs),
        `${m.sharePct.toFixed(1)}%`,
      ]),
    );
  }

  if (report.sessions.length > 0) {
    console.log('\n--- Top Sessions ---');
    printTable(
      ['Session', 'Model', 'Steps', 'Tokens', `Cost (${prefs.currency})`, 'Title'],
      report.sessions.slice(0, 10).map((s) => [
        s.convId.slice(0, 8),
        s.primaryModel,
        fmtNum(s.steps),
        fmtCompact(s.total),
        fmtMoney(s.costUsd, prefs),
        (s.title || '(untitled)').slice(0, 48),
      ]),
    );
  }
}

function cmdSync(flags) {
  const res = syncAllTranscripts({ forceFullRescan: Boolean(flags.full), dataDir: getDataDir() });
  console.log(JSON.stringify(res, null, 2));
}

function cmdPricing() {
  const card = listOfficialRateCard();
  console.log('Google Official Gemini API Pricing (Paid Tier Global, USD per 1M tokens):\n');
  printTable(
    ['Model Family', 'Prefix', 'Input', 'Cache Read', 'Output', 'Notes'],
    card.map((r) => [
      r.family,
      r.prefix,
      `$${r.input}`,
      `$${r.cacheRead}`,
      `$${r.output}`,
      r.tierNote,
    ]),
  );
}

function cmdSetCurrency(pos, flags) {
  const raw = String(pos[1] || flags.currency || '').toUpperCase();
  if (raw !== 'USD' && raw !== 'CNY') {
    console.error('Usage: set-currency <USD|CNY> [--cny-rate 7.25]');
    process.exit(1);
  }
  const saved = savePrefs(
    { currency: raw, cnyRate: flags['cny-rate'] !== undefined ? Number(flags['cny-rate']) : undefined },
    getDataDir(),
  );
  console.log(`Updated display currency: ${saved.currency} (CNY/USD rate: ${saved.cnyRate})`);
}

function cmdExport(flags) {
  const dataDir = getDataDir();
  syncAllTranscripts({ dataDir });
  const days = flags.days !== undefined ? Number(flags.days) : 30;
  const report = buildReport({ dataDir, rangeDays: Number.isFinite(days) ? days : 30 });
  const csv = exportDailyCsv(report);
  if (flags.out) {
    writeFileSync(flags.out, csv, 'utf-8');
    console.log(`Exported CSV to ${flags.out}`);
  } else {
    process.stdout.write(csv);
  }
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos[0] || 'summary';

switch (cmd) {
  case 'summary':
    cmdSummary(flags);
    break;
  case 'sync':
    cmdSync(flags);
    break;
  case 'pricing':
    cmdPricing();
    break;
  case 'set-currency':
    cmdSetCurrency(pos, flags);
    break;
  case 'export':
    cmdExport(flags);
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('Commands: summary | sync | pricing | set-currency | export');
    process.exit(1);
}
