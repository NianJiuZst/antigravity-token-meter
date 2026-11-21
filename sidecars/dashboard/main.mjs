import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { buildReport, exportDailyCsv, syncAllTranscripts } from '../../lib/ledger.mjs';
import { getDataDir, savePrefs } from '../../lib/pricing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNC_INTERVAL_MS = 4_000;
let lastSyncAt = 0;
let lastSyncError = '';

function runSync({ force = false, full = false, throwOnError = false } = {}) {
  const now = Date.now();
  if (!force && !full && now - lastSyncAt < SYNC_INTERVAL_MS) {
    return null;
  }
  try {
    const res = syncAllTranscripts({ forceFullRescan: full, dataDir: getDataDir() });
    lastSyncAt = Date.now();
    lastSyncError = '';
    return res;
  } catch (err) {
    lastSyncError = err?.message || String(err);
    console.error('[token_meter] sync error:', lastSyncError);
    if (throwOnError) throw err;
    return null;
  }
}

const initRes = runSync({ force: true, full: false, throwOnError: false });
console.log(
  `[token_meter] ready: dataDir=${getDataDir()}`,
  initRes ? `transcripts=${initRes.totalTranscripts} added=${initRes.added}` : `syncError=${lastSyncError}`,
);

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

app.api(
  '/styles.css',
  () => new Response(readFileSync(join(__dirname, 'styles.css'), 'utf-8'), { contentType: 'text/css; charset=utf-8' }),
  'GET',
);

app.api(
  '/app.js',
  () =>
    new Response(readFileSync(join(__dirname, 'app.js'), 'utf-8'), {
      contentType: 'application/javascript; charset=utf-8',
    }),
  'GET',
);

app.api(
  '/api/report',
  (data) => {
    const force = data?.force === '1' || data?.force === 'true';
    runSync({ force, full: false, throwOnError: false });

    const days = data?.days !== undefined && data.days !== '' ? Number(data.days) : 7;
    const tz = typeof data?.tz === 'string' && data.tz.trim() ? data.tz.trim() : undefined;
    const convId =
      (typeof data?.conversationId === 'string' && data.conversationId) ||
      app.config?.conversationId ||
      '';

    const report = buildReport({
      dataDir: getDataDir(),
      rangeDays: Number.isFinite(days) ? days : 7,
      timeZone: tz,
      activeConvId: convId,
    });

    const etag = `${report.etag}|se=${lastSyncError ? '1' : '0'}`;
    if (data?.etag && data.etag === etag) {
      return { unchanged: true, etag, syncedAt: lastSyncAt, syncError: lastSyncError || null };
    }
    return { ...report, etag, syncedAt: lastSyncAt, syncError: lastSyncError || null };
  },
  'GET',
);

app.api(
  '/api/export.csv',
  (data) => {
    runSync({ force: false, full: false, throwOnError: false });
    const days = data?.days !== undefined && data.days !== '' ? Number(data.days) : 30;
    const tz = typeof data?.tz === 'string' && data.tz.trim() ? data.tz.trim() : undefined;

    const report = buildReport({
      dataDir: getDataDir(),
      rangeDays: Number.isFinite(days) ? days : 30,
      timeZone: tz,
    });
    const csv = exportDailyCsv(report);
    return new Response(csv, {
      contentType: 'text/csv; charset=utf-8',
      headers: {
        'Content-Disposition': `attachment; filename="token-meter-${report.todayDate}.csv"`,
      },
    });
  },
  'GET',
);

app.api(
  '/api/prefs',
  (data) => {
    const saved = savePrefs(data || {}, getDataDir());
    return { ok: true, prefs: saved };
  },
  'POST',
);

app.api(
  '/api/sync',
  (data) => {
    const full = Boolean(data?.full);
    const res = runSync({ force: true, full, throwOnError: true });
    return { ok: true, ...res, syncedAt: lastSyncAt };
  },
  'POST',
);

app.run();
