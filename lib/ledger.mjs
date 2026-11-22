import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import {
  calcCostUsd,
  formatModelLabel,
  getContextWindow,
  getDataDir,
  listOfficialRateCard,
  loadPrefs,
  normalizeModel,
  prefsMtime,
  resolveModelRate,
} from './pricing.mjs';

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 4_000;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, Math.max(1, ms));
}

function isPidDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === 'ESRCH';
  }
}

function withLock(dataDir, fn) {
  mkdirSync(dataDir, { recursive: true });
  const lockFile = join(dataDir, '.ledger.lock');
  const owner = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}\n`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = false;

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      try {
        writeSync(fd, owner);
      } finally {
        closeSync(fd);
      }
      acquired = true;
      break;
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
      try {
        const s = statSync(lockFile);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          let holderPid = 0;
          try {
            holderPid = Number(readFileSync(lockFile, 'utf-8').split(':')[0]);
          } catch {
            holderPid = 0;
          }
          if (isPidDead(holderPid)) {
            try {
              unlinkSync(lockFile);
            } catch {
              // another worker cleared it
            }
            continue;
          }
        }
      } catch {
        continue;
      }
      sleepMs(15 + Math.floor(Math.random() * 25));
    }
  }

  if (!acquired) {
    const err = new Error('Ledger lock busy; retry shortly.');
    err.code = 'ELOCKED';
    throw err;
  }

  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lockFile, 'utf-8') === owner) {
        unlinkSync(lockFile);
      }
    } catch {
      // already removed
    }
  }
}

function atomicWriteJson(filePath, obj) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  renameSync(tmp, filePath);
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function discoverBrainRoots() {
  const override = process.env.TOKEN_METER_BRAIN_ROOTS;
  if (override) {
    return override
      .split(delimiter)
      .map((s) => s.trim())
      .filter((s) => s && existsSync(s))
      .map((brainDir) => ({ app: basename(dirname(brainDir)) || 'custom', brainDir }));
  }
  const geminiRoot = join(homedir(), '.gemini');
  const roots = [];
  for (const name of safeReaddir(geminiRoot).sort()) {
    const brainDir = join(geminiRoot, name, 'brain');
    if (existsSync(brainDir)) {
      roots.push({ app: name, brainDir });
    }
  }
  return roots;
}

export function discoverTranscripts() {
  const out = [];
  for (const { app, brainDir } of discoverBrainRoots()) {
    for (const convId of safeReaddir(brainDir)) {
      if (!convId || convId.startsWith('.')) continue;
      const filePath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (existsSync(filePath)) {
        out.push({ app, convId, filePath });
      }
    }
  }
  return out;
}

function inferMetaFromPath(filePath) {
  // .../<app>/brain/<convId>/.system_generated/logs/transcript.jsonl
  const logsDir = dirname(filePath);
  const sysDir = dirname(logsDir);
  const convDir = dirname(sysDir);
  const brainDir = dirname(convDir);
  const appDir = dirname(brainDir);
  return {
    convId: basename(convDir) || 'unknown',
    app: basename(brainDir) === 'brain' ? basename(appDir) : 'antigravity',
  };
}

function truncateTitle(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > 90 ? `${cleaned.slice(0, 89)}…` : cleaned;
}

function extractTitleFromUserInput(content) {
  if (!content || typeof content !== 'string') return '';
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  const raw = reqMatch && reqMatch[1] ? reqMatch[1] : content.replace(/<[^>]+>/g, ' ');
  return truncateTitle(raw);
}

function extractTitleFromSystemMessage(content) {
  if (!content || typeof content !== 'string') return '';
  const sysMatch = /<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/i.exec(content);
  const body = sysMatch ? sysMatch[1] : content;
  const contentIdx = body.indexOf('content=');
  const payload = contentIdx >= 0 ? body.slice(contentIdx + 8).trim() : body.trim();
  if (!payload || /^\[swarm\]\s+new board message\b/i.test(payload)) return '';

  const swarmAssign = /Your assignment\s*\([^)]*for\s+(@[\w-]+)\)\s*:\s*([\s\S]+)/i.exec(payload);
  if (swarmAssign) {
    return truncateTitle(`[Swarm ${swarmAssign[1]}] ${swarmAssign[2]}`);
  }

  const origTask = /<original_task>\s*([\s\S]*?)(?:<\/original_task>|\n---|$)/i.exec(payload);
  if (origTask) {
    const cleanedTask = origTask[1].replace(/^\s*\*\*Task\*\*\s*:\s*/i, '');
    return truncateTitle(`[Subagent] ${cleanedTask}`);
  }

  return truncateTitle(`[Subagent] ${payload.replace(/<[^>]+>/g, ' ')}`);
}

const MODEL_CHANGE_RE = /Model Selection`\s+from\s+.*?\s+to\s+([^\n]+?)\.(?=\s|$)/g;
const SENDER_CONV_RE = /\bsender=([0-9a-f-]{36})\b/i;

function extractSenderConvId(content) {
  if (!content || typeof content !== 'string') return '';
  const m = SENDER_CONV_RE.exec(content);
  return m ? m[1] : '';
}

function extractLastModelChange(content) {
  if (!content || typeof content !== 'string') return null;
  let last = null;
  MODEL_CHANGE_RE.lastIndex = 0;
  let m;
  while ((m = MODEL_CHANGE_RE.exec(content)) !== null) {
    if (m[1]) last = normalizeModel(m[1]);
  }
  return last;
}

function cursorsPath(dataDir) {
  return join(dataDir, 'cursors.json');
}

function eventsDir(dataDir) {
  return join(dataDir, 'events');
}

function readCursorsState(dataDir) {
  const path = cursorsPath(dataDir);
  if (!existsSync(path)) {
    return { version: 1, files: {}, sessions: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      version: 1,
      files: parsed?.files && typeof parsed.files === 'object' ? parsed.files : {},
      sessions: parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    };
  } catch {
    return { version: 1, files: {}, sessions: {} };
  }
}

function scanTranscriptDelta(filePath, prevCursor, fallbackMeta, forceFull = false) {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return null;
  }

  const prev = prevCursor && typeof prevCursor === 'object' ? prevCursor : null;
  if (
    !forceFull &&
    prev &&
    prev.size === st.size &&
    prev.mtimeMs === st.mtimeMs &&
    (!prev.ino || prev.ino === st.ino)
  ) {
    return { unchanged: true };
  }

  const replacedOrShrank = Boolean(
    prev && ((prev.ino && prev.ino !== st.ino) || (typeof prev.offset === 'number' && st.size < prev.offset)),
  );
  let offset = !forceFull && !replacedOrShrank && prev && typeof prev.offset === 'number' ? prev.offset : 0;
  let lastModel = !forceFull && !replacedOrShrank && prev && typeof prev.lastModel === 'string' ? prev.lastModel : '';
  let parentConvId = prev && typeof prev.parentConvId === 'string' ? prev.parentConvId : '';
  let title = prev && typeof prev.title === 'string' ? prev.title : '';
  let firstTs = prev && typeof prev.firstTs === 'number' ? prev.firstTs : 0;
  let lastTs = prev && typeof prev.lastTs === 'number' ? prev.lastTs : 0;
  let lastPlannerStepIdx =
    !forceFull && !replacedOrShrank && prev && Number.isFinite(prev.lastPlannerStepIdx)
      ? prev.lastPlannerStepIdx
      : -1;
  let lastPlannerTs =
    !forceFull && !replacedOrShrank && prev && Number.isFinite(prev.lastPlannerTs)
      ? prev.lastPlannerTs
      : 0;

  if (forceFull) {
    offset = 0;
    lastModel = '';
    parentConvId = '';
    title = '';
    firstTs = 0;
    lastTs = 0;
    lastPlannerStepIdx = -1;
    lastPlannerTs = 0;
  }

  const bytesToRead = st.size - offset;
  const events = [];
  let newOffset = offset;

  if (bytesToRead > 0) {
    const buf = Buffer.allocUnsafe(bytesToRead);
    const fd = openSync(filePath, 'r');
    let totalRead = 0;
    try {
      while (totalRead < bytesToRead) {
        const n = readSync(fd, buf, totalRead, bytesToRead - totalRead, offset + totalRead);
        if (n <= 0) break;
        totalRead += n;
      }
    } finally {
      closeSync(fd);
    }

    const slice = totalRead === bytesToRead ? buf : buf.subarray(0, totalRead);
    const lastNl = slice.lastIndexOf(0x0a);
    let parseChunk = '';
    let trailingChunk = '';

    if (lastNl >= 0) {
      parseChunk = slice.subarray(0, lastNl + 1).toString('utf-8');
      newOffset = offset + lastNl + 1;
      if (lastNl + 1 < slice.length) {
        trailingChunk = slice.subarray(lastNl + 1).toString('utf-8');
      }
    } else {
      trailingChunk = slice.toString('utf-8');
    }

    const lines = parseChunk ? parseChunk.split('\n') : [];
    const parsedObjects = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object') parsedObjects.push(obj);
      } catch {
        // Ignore corrupted line inside already-newline-terminated content.
      }
    }

    if (trailingChunk.trim()) {
      try {
        const obj = JSON.parse(trailingChunk);
        if (obj && typeof obj === 'object') {
          parsedObjects.push(obj);
          newOffset = offset + slice.length;
        }
      } catch {
        // Torn final line still being written: hold newOffset before it.
      }
    }

    const convId = fallbackMeta.convId;
    for (const obj of parsedObjects) {
      const ts = obj.created_at ? Date.parse(obj.created_at) : NaN;
      if (Number.isFinite(ts)) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }

      if (obj.type === 'USER_INPUT') {
        if (!title || title.startsWith('[Subagent]') || title.startsWith('[Swarm ')) {
          const extracted = extractTitleFromUserInput(obj.content);
          if (extracted) title = extracted;
        }
        const changedModel = extractLastModelChange(obj.content);
        if (changedModel) lastModel = changedModel;
      } else if (obj.type === 'SYSTEM_MESSAGE') {
        if (!parentConvId && Number(obj.step_index) <= 2 && (!title || title.startsWith('[Subagent]') || title.startsWith('[Swarm '))) {
          const sender = extractSenderConvId(obj.content);
          if (sender && sender !== convId) parentConvId = sender;
        }
        if (!title) {
          const extracted = extractTitleFromSystemMessage(obj.content);
          if (extracted) title = extracted;
        }
      }

      const hasTokens =
        Object.prototype.hasOwnProperty.call(obj, 'input_tokens') ||
        Object.prototype.hasOwnProperty.call(obj, 'cache_read_tokens') ||
        Object.prototype.hasOwnProperty.call(obj, 'output_tokens');

      if (!hasTokens) continue;
      if (obj.status && obj.status !== 'DONE') continue;

      const stepIdx = Number(obj.step_index);
      if (!Number.isFinite(stepIdx) || !Number.isFinite(ts)) continue;

      if (obj.model) {
        lastModel = normalizeModel(obj.model);
      }
      const model = obj.model ? normalizeModel(obj.model) : lastModel || 'unknown';
      const inTok = Math.max(0, Number(obj.input_tokens) || 0);
      const crTok = Math.max(0, Number(obj.cache_read_tokens) || 0);
      const outTok = Math.max(0, Number(obj.output_tokens) || 0);
      if (inTok + crTok + outTok === 0) continue;

      const kind = obj.type === 'CHECKPOINT' ? 'C' : obj.type === 'PLANNER_RESPONSE' ? 'P' : String(obj.type || 'O').slice(0, 1);
      if (kind === 'P' && stepIdx >= lastPlannerStepIdx) {
        lastPlannerStepIdx = stepIdx;
        lastPlannerTs = ts;
      }
      events.push({
        c: convId,
        i: stepIdx,
        ts,
        m: model,
        k: kind,
        in: inTok,
        cr: crTok,
        out: outTok,
      });
    }
  }

  return {
    unchanged: false,
    events,
    cursor: {
      size: st.size,
      mtimeMs: st.mtimeMs,
      ino: st.ino,
      offset: newOffset,
      lastModel,
      parentConvId,
      title,
      firstTs,
      lastTs,
      lastPlannerStepIdx,
      lastPlannerTs,
      convId: fallbackMeta.convId,
      app: fallbackMeta.app,
    },
  };
}

function appendEventsByMonth(dataDir, events) {
  if (!events.length) return;
  const dir = eventsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const byMonth = new Map();
  for (const e of events) {
    const month = new Date(e.ts).toISOString().slice(0, 7);
    let bucket = byMonth.get(month);
    if (!bucket) {
      bucket = [];
      byMonth.set(month, bucket);
    }
    bucket.push(JSON.stringify(e));
  }
  for (const [month, lines] of byMonth.entries()) {
    appendFileSync(join(dir, `${month}.jsonl`), lines.join('\n') + '\n', 'utf-8');
  }
}

function compactEventsPreservingArchived(dataDir, rebuiltEvents) {
  // Merge existing persisted events (so deleted transcripts are never lost!)
  // with newly rebuilt events (rebuilt takes precedence for same convId:stepIdx).
  const dir = eventsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const merged = new Map();

  for (const file of safeReaddir(dir).sort()) {
    if (!file.endsWith('.jsonl')) continue;
    const text = readFileSync(join(dir, file), 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.c === 'string' && Number.isFinite(e.i)) {
          merged.set(`${e.c}:${e.i}`, e);
        }
      } catch {
        // skip
      }
    }
  }

  for (const e of rebuiltEvents) {
    merged.set(`${e.c}:${e.i}`, e);
  }

  const byMonth = new Map();
  for (const e of merged.values()) {
    const month = new Date(e.ts).toISOString().slice(0, 7);
    let bucket = byMonth.get(month);
    if (!bucket) {
      bucket = [];
      byMonth.set(month, bucket);
    }
    bucket.push(e);
  }

  for (const [month, list] of byMonth.entries()) {
    list.sort((a, b) => a.ts - b.ts || a.i - b.i);
    const target = join(dir, `${month}.jsonl`);
    const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmp, list.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    renameSync(tmp, target);
  }
}

const MAX_STEP_END_DELTA_MS = 3_600_000;

function mergeSessionStepEndTs(prevSession, stepIdx, stepTs, stopAt) {
  const existing =
    prevSession?.stepEndTs && typeof prevSession.stepEndTs === 'object' ? prevSession.stepEndTs : null;
  if (
    !Number.isFinite(stopAt) ||
    stopAt <= 0 ||
    !Number.isFinite(stepIdx) ||
    stepIdx < 0 ||
    !Number.isFinite(stepTs) ||
    stepTs <= 0 ||
    stopAt <= stepTs ||
    stopAt - stepTs >= MAX_STEP_END_DELTA_MS
  ) {
    return { stepEndTs: existing, updated: false };
  }
  const key = String(stepIdx);
  if (existing && Number.isFinite(existing[key])) {
    return { stepEndTs: existing, updated: false };
  }
  return {
    stepEndTs: { ...(existing || {}), [key]: Math.round(stopAt) },
    updated: true,
  };
}

export function syncSingleTranscript(transcriptPath, meta = {}, dataDir = getDataDir()) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { added: 0, scanned: 0 };
  }
  const inferred = inferMetaFromPath(transcriptPath);
  const fullMeta = {
    convId: meta.convId || inferred.convId,
    app: meta.app || inferred.app,
  };
  const stopAt = Number.isFinite(meta.stopAt) && meta.stopAt > 0 ? Math.round(meta.stopAt) : 0;

  return withLock(dataDir, () => {
    const state = readCursorsState(dataDir);
    const prevCursor = state.files[transcriptPath];
    const res = scanTranscriptDelta(transcriptPath, prevCursor, fullMeta, false);
    if (!res) {
      return { added: 0, scanned: 1 };
    }
    const prevSession = state.sessions[fullMeta.convId] || {};
    const activeCursor = res.unchanged ? prevCursor : res.cursor;
    const targetStepIdx = Number.isFinite(activeCursor?.lastPlannerStepIdx)
      ? activeCursor.lastPlannerStepIdx
      : Number.isFinite(prevSession.lastPlannerStepIdx)
        ? prevSession.lastPlannerStepIdx
        : -1;
    const targetStepTs = Number.isFinite(activeCursor?.lastPlannerTs)
      ? activeCursor.lastPlannerTs
      : Number.isFinite(prevSession.lastPlannerTs)
        ? prevSession.lastPlannerTs
        : 0;
    const { stepEndTs, updated: endTsUpdated } = mergeSessionStepEndTs(
      prevSession,
      targetStepIdx,
      targetStepTs,
      stopAt,
    );

    if (res.unchanged) {
      if (endTsUpdated) {
        state.sessions[fullMeta.convId] = {
          convId: fullMeta.convId,
          app: prevSession.app || fullMeta.app,
          title: prevSession.title || '',
          parentConvId: prevSession.parentConvId || '',
          lastModel: prevSession.lastModel || '',
          firstTs: prevSession.firstTs || 0,
          lastTs: prevSession.lastTs || 0,
          lastPlannerStepIdx: targetStepIdx,
          lastPlannerTs: targetStepTs,
          stepEndTs,
        };
        atomicWriteJson(cursorsPath(dataDir), state);
      }
      return { added: 0, scanned: 1 };
    }

    if (endTsUpdated && res.events.length) {
      for (let i = res.events.length - 1; i >= 0; i--) {
        if (res.events[i].i === targetStepIdx && res.events[i].k === 'P') {
          res.events[i].endTs = stopAt;
          break;
        }
      }
    }
    if (res.events.length) {
      appendEventsByMonth(dataDir, res.events);
    }
    state.files[transcriptPath] = res.cursor;
    state.sessions[fullMeta.convId] = {
      convId: fullMeta.convId,
      app: fullMeta.app,
      title: res.cursor.title || prevSession.title || '',
      parentConvId: res.cursor.parentConvId || prevSession.parentConvId || '',
      lastModel: res.cursor.lastModel || prevSession.lastModel || '',
      firstTs: res.cursor.firstTs || prevSession.firstTs || 0,
      lastTs: Math.max(res.cursor.lastTs || 0, prevSession.lastTs || 0),
      ...(targetStepIdx >= 0 ? { lastPlannerStepIdx: targetStepIdx, lastPlannerTs: targetStepTs } : {}),
      ...(stepEndTs ? { stepEndTs } : {}),
    };
    atomicWriteJson(cursorsPath(dataDir), state);
    return { added: res.events.length, scanned: 1 };
  });
}

export function syncAllTranscripts({ forceFullRescan = false, dataDir = getDataDir() } = {}) {
  const transcripts = discoverTranscripts();
  return withLock(dataDir, () => {
    const state = readCursorsState(dataDir);
    const newEvents = [];
    let changedFiles = 0;

    for (const item of transcripts) {
      const res = scanTranscriptDelta(item.filePath, state.files[item.filePath], item, forceFullRescan);
      if (!res || res.unchanged) continue;
      changedFiles += 1;
      const prevSession = state.sessions[item.convId] || {};
      const prevEndMap =
        prevSession.stepEndTs && typeof prevSession.stepEndTs === 'object' ? prevSession.stepEndTs : null;
      if (res.events.length) {
        for (const e of res.events) {
          if (prevEndMap && e.k === 'P' && Number.isFinite(prevEndMap[String(e.i)])) {
            e.endTs = prevEndMap[String(e.i)];
          }
          newEvents.push(e);
        }
      }
      state.files[item.filePath] = res.cursor;
      const lastPlannerStepIdx = Number.isFinite(res.cursor.lastPlannerStepIdx)
        ? res.cursor.lastPlannerStepIdx
        : Number.isFinite(prevSession.lastPlannerStepIdx)
          ? prevSession.lastPlannerStepIdx
          : -1;
      const lastPlannerTs = Number.isFinite(res.cursor.lastPlannerTs)
        ? res.cursor.lastPlannerTs
        : Number.isFinite(prevSession.lastPlannerTs)
          ? prevSession.lastPlannerTs
          : 0;
      state.sessions[item.convId] = {
        convId: item.convId,
        app: item.app,
        title: res.cursor.title || prevSession.title || '',
        parentConvId: res.cursor.parentConvId || prevSession.parentConvId || '',
        lastModel: res.cursor.lastModel || prevSession.lastModel || '',
        firstTs: res.cursor.firstTs || prevSession.firstTs || 0,
        lastTs: Math.max(res.cursor.lastTs || 0, prevSession.lastTs || 0),
        ...(lastPlannerStepIdx >= 0 ? { lastPlannerStepIdx, lastPlannerTs } : {}),
        ...(prevEndMap ? { stepEndTs: prevEndMap } : {}),
      };
    }

    if (forceFullRescan) {
      compactEventsPreservingArchived(dataDir, newEvents);
      atomicWriteJson(cursorsPath(dataDir), state);
    } else if (changedFiles > 0) {
      if (newEvents.length) {
        appendEventsByMonth(dataDir, newEvents);
      }
      atomicWriteJson(cursorsPath(dataDir), state);
    }

    return {
      totalTranscripts: transcripts.length,
      changedFiles,
      added: newEvents.length,
    };
  });
}

// Per-file parsed cache for fast sidecar polling
const monthFileCache = new Map(); // fullPath -> { key, events }

export function loadLedger(dataDir = getDataDir()) {
  const dir = eventsDir(dataDir);
  const files = safeReaddir(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();

  const dedup = new Map();
  const fpParts = [];

  for (const name of files) {
    const fullPath = join(dir, name);
    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    const key = `${st.mtimeMs}:${st.size}`;
    fpParts.push(`${name}=${key}`);
    let cached = monthFileCache.get(fullPath);
    if (!cached || cached.key !== key) {
      const parsed = [];
      const text = readFileSync(fullPath, 'utf-8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e && typeof e.c === 'string' && Number.isFinite(e.i) && Number.isFinite(e.ts)) {
            parsed.push(e);
          }
        } catch {
          // ignore malformed line
        }
      }
      cached = { key, events: parsed };
      monthFileCache.set(fullPath, cached);
    }
    for (const e of cached.events) {
      dedup.set(`${e.c}:${e.i}`, e);
    }
  }

  const state = readCursorsState(dataDir);
  let cursorsStamp = 'none';
  try {
    const cs = statSync(cursorsPath(dataDir));
    cursorsStamp = `${cs.mtimeMs}:${cs.size}`;
  } catch {
    cursorsStamp = 'none';
  }
  const events = Array.from(dedup.values()).sort((a, b) => a.ts - b.ts || a.i - b.i);
  const fingerprint = `${fpParts.join('|')}|p=${prefsMtime(dataDir)}|c=${cursorsStamp}`;

  return {
    events,
    sessions: state.sessions,
    fingerprint,
  };
}

const tzFormatterCache = new Map();

export function resolveTimeZone(tz) {
  const candidate =
    typeof tz === 'string' && tz.trim()
      ? tz.trim()
      : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate });
    return candidate;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
}

export function localDateKey(tsMs, timeZone = resolveTimeZone()) {
  let fmt = tzFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    tzFormatterCache.set(timeZone, fmt);
  }
  return fmt.format(tsMs);
}

function addDaysUtcDateStr(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function diffDaysUtcDateStr(startStr, endStr) {
  const [y1, m1, d1] = startStr.split('-').map(Number);
  const [y2, m2, d2] = endStr.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

function emptyBucket() {
  return {
    steps: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    total: 0,
    costUsd: 0,
    inputCostUsd: 0,
    cacheCostUsd: 0,
    outputCostUsd: 0,
    cacheSavedUsd: 0,
  };
}

function accumulate(bucket, e, cost) {
  bucket.steps += 1;
  bucket.input += e.in;
  bucket.cacheRead += e.cr;
  bucket.output += e.out;
  bucket.total += e.in + e.cr + e.out;
  bucket.costUsd += cost.total;
  bucket.inputCostUsd += cost.inputCost;
  bucket.cacheCostUsd += cost.cacheCost;
  bucket.outputCostUsd += cost.outputCost;
  bucket.cacheSavedUsd += cost.cacheSaved;
}

function finalizeBucket(bucket) {
  const promptTotal = bucket.input + bucket.cacheRead;
  return {
    ...bucket,
    promptTotal,
    cacheHitRate: promptTotal > 0 ? bucket.cacheRead / promptTotal : 0,
  };
}

export function buildReport({
  dataDir = getDataDir(),
  rangeDays = 7,
  timeZone,
  activeConvId = '',
  prefs = loadPrefs(dataDir),
} = {}) {
  const { events, sessions, fingerprint } = loadLedger(dataDir);
  const now = Date.now();
  const resolvedTz = resolveTimeZone(timeZone);
  const todayStr = localDateKey(now, resolvedTz);

  // Determine start date for requested window (0 = all time, 1 = today only, N = last N calendar days incl today)
  const parsedRange = Number(rangeDays);
  const days = Number.isFinite(parsedRange) && parsedRange >= 0 ? Math.floor(parsedRange) : 7;
  const startDateStr = days > 0 ? addDaysUtcDateStr(todayStr, -(days - 1)) : '';

  const allTimeAcc = emptyBucket();
  const todayAcc = emptyBucket();
  const periodAcc = emptyBucket();
  const activeSessionAcc = emptyBucket();

  const dailyMap = new Map();
  const modelMap = new Map();
  const sessionMap = new Map();

  // Resolve inherited model for legacy pre-Nov-19 subagents via sender=parentConvId chain
  const inheritedModelCache = new Map();
  const resolveEventModel = (convId, rawModel) => {
    const norm = normalizeModel(rawModel);
    if (norm !== 'unknown') return norm;
    if (inheritedModelCache.has(convId)) return inheritedModelCache.get(convId);
    let cur = convId;
    const visited = new Set([convId]);
    let found = 'unknown';
    while (cur) {
      const meta = sessions[cur];
      const parent = meta?.parentConvId;
      if (!parent || visited.has(parent)) break;
      visited.add(parent);
      const pm = normalizeModel(sessions[parent]?.lastModel);
      if (pm !== 'unknown') {
        found = pm;
        break;
      }
      cur = parent;
    }
    inheritedModelCache.set(convId, found);
    return found;
  };

  for (const e of events) {
    const model = resolveEventModel(e.c, e.m);
    const rate = resolveModelRate(model, { ts: e.ts, promptTotal: e.in + e.cr });
    const cost = calcCostUsd(e.in, e.cr, e.out, rate);
    const dateStr = localDateKey(e.ts, resolvedTz);

    accumulate(allTimeAcc, e, cost);
    if (dateStr === todayStr) {
      accumulate(todayAcc, e, cost);
    }
    if (activeConvId && e.c === activeConvId) {
      accumulate(activeSessionAcc, e, cost);
    }

    if (startDateStr && dateStr < startDateStr) continue;

    accumulate(periodAcc, e, cost);

    // Daily bucket
    let dayEntry = dailyMap.get(dateStr);
    if (!dayEntry) {
      dayEntry = { date: dateStr, ...emptyBucket(), byModel: {} };
      dailyMap.set(dateStr, dayEntry);
    }
    accumulate(dayEntry, e, cost);
    dayEntry.byModel[model] = (dayEntry.byModel[model] || 0) + cost.total;

    // Model bucket (display current official rate at `now`, while cost reflects exact step-level rate)
    let mEntry = modelMap.get(model);
    if (!mEntry) {
      const displayRate = resolveModelRate(model, { ts: now, promptTotal: 0 });
      mEntry = {
        model,
        label: formatModelLabel(model),
        ...emptyBucket(),
        rate: { input: displayRate.input, cacheRead: displayRate.cacheRead, output: displayRate.output },
        tierNote: displayRate.tierNote,
        matchType: displayRate.matchType,
        matchedRule: displayRate.matchedRule,
      };
      modelMap.set(model, mEntry);
    }
    accumulate(mEntry, e, cost);

    // Session bucket
    let sEntry = sessionMap.get(e.c);
    if (!sEntry) {
      const meta = sessions[e.c] || {};
      sEntry = {
        convId: e.c,
        title: meta.title || '',
        app: meta.app || 'antigravity',
        firstTs: e.ts,
        lastTs: e.ts,
        ...emptyBucket(),
        modelCounts: {},
      };
      sessionMap.set(e.c, sEntry);
    }
    accumulate(sEntry, e, cost);
    if (e.ts < sEntry.firstTs) sEntry.firstTs = e.ts;
    if (e.ts > sEntry.lastTs) sEntry.lastTs = e.ts;
    sEntry.modelCounts[model] = (sEntry.modelCounts[model] || 0) + 1;
  }

  // Build daily series: continuous for <= 365-day spans; all active dates (never truncated) for wider spans
  const daily = [];
  if (days > 0) {
    for (let i = 0; i < days; i++) {
      const d = addDaysUtcDateStr(startDateStr, i);
      const raw = dailyMap.get(d);
      daily.push(
        raw
          ? finalizeBucket(raw)
          : { date: d, ...finalizeBucket(emptyBucket()), byModel: {} },
      );
    }
  } else {
    const sortedDates = Array.from(dailyMap.keys()).sort();
    if (sortedDates.length > 0) {
      const first = sortedDates[0];
      const end = sortedDates[sortedDates.length - 1] > todayStr ? sortedDates[sortedDates.length - 1] : todayStr;
      const span = diffDaysUtcDateStr(first, end);
      if (span <= 365) {
        let cur = first;
        while (cur <= end) {
          const raw = dailyMap.get(cur);
          daily.push(
            raw
              ? finalizeBucket(raw)
              : { date: cur, ...finalizeBucket(emptyBucket()), byModel: {} },
          );
          cur = addDaysUtcDateStr(cur, 1);
        }
      } else {
        for (const d of sortedDates) {
          daily.push(finalizeBucket(dailyMap.get(d)));
        }
      }
    }
  }

  const periodFinal = finalizeBucket(periodAcc);
  const activeDays = dailyMap.size;

  const models = Array.from(modelMap.values())
    .map((m) => ({
      ...finalizeBucket(m),
      sharePct: periodFinal.costUsd > 0 ? (m.costUsd / periodFinal.costUsd) * 100 : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.total - a.total);

  const sessionList = Array.from(sessionMap.values())
    .map((s) => {
      let primaryModel = 'unknown';
      let maxCnt = -1;
      for (const [m, cnt] of Object.entries(s.modelCounts)) {
        if (cnt > maxCnt) {
          maxCnt = cnt;
          primaryModel = m;
        }
      }
      const { modelCounts: _mc, ...rest } = s;
      return {
        ...finalizeBucket(rest),
        primaryModel,
        primaryModelLabel: formatModelLabel(primaryModel),
        isCurrent: Boolean(activeConvId && s.convId === activeConvId),
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.lastTs - a.lastTs);

  const activeSessionMeta = activeConvId ? sessions[activeConvId] : null;
  const activeSession = activeConvId
    ? {
        convId: activeConvId,
        title: activeSessionMeta?.title || '',
        ...finalizeBucket(activeSessionAcc),
      }
    : null;

  // Resolve live turn-level telemetry for the active conversation (or latest active session standalone)
  let liveTargetConv = activeConvId;
  let isFallbackLatest = false;
  if (!liveTargetConv) {
    let newestTs = 0;
    for (const s of Object.values(sessions)) {
      if ((s.lastTs || 0) > newestTs) {
        newestTs = s.lastTs || 0;
        liveTargetConv = s.convId;
      }
    }
    if (liveTargetConv) isFallbackLatest = true;
  }

  let liveConversation = null;
  if (liveTargetConv) {
    const fallbackModel = resolveEventModel(liveTargetConv, sessions[liveTargetConv]?.lastModel || 'unknown');
    const detail = getConversationLiveDetail(liveTargetConv, {
      fallbackModel: fallbackModel !== 'unknown' ? fallbackModel : '',
      fallbackTitle: sessions[liveTargetConv]?.title || '',
      stepEndTs: sessions[liveTargetConv]?.stepEndTs || null,
    });
    if (detail) {
      liveConversation = { ...detail, isFallbackLatest };
    }
  }

  const liveStamp = liveConversation ? `${liveConversation.convId}:${liveConversation.mtimeStamp}` : 'none';

  return {
    generatedAt: now,
    etag: `${fingerprint}|today=${todayStr}|d=${days}|tz=${resolvedTz}|c=${activeConvId}|l=${liveStamp}`,
    todayDate: todayStr,
    rangeDays: days,
    timeZone: resolvedTz,
    today: finalizeBucket(todayAcc),
    period: {
      ...periodFinal,
      activeDays,
      avgDailyCostUsd: activeDays > 0 ? periodFinal.costUsd / activeDays : 0,
    },
    allTime: {
      ...finalizeBucket(allTimeAcc),
      totalSessions: Object.keys(sessions).length,
      totalEvents: events.length,
    },
    activeSession,
    liveConversation,
    daily,
    models,
    sessions: sessionList,
    officialRateCard: listOfficialRateCard(now),
    prefs,
  };
}

const SAFE_CONV_ID_RE = /^[A-Za-z0-9._-]+$/;
const COMPLETED_AT_RE = /^Completed At:\s*([^\r\n]+)/m;
const liveConvCache = new Map(); // filePath -> { key, detail }
const dbTimingsCache = new Map(); // dbPath -> { stamp, map }
const _require = createRequire(import.meta.url);
let _sqliteLoader;

const MIN_DECODE_MS = 100;
const HELD_WINDOW_MS = 1000;
const HELD_SHARE = 4;
const MAX_DECODE_TPS = 10_000;

function getDatabaseSync() {
  if (_sqliteLoader !== undefined) return _sqliteLoader;
  try {
    const mod = _require('node:sqlite');
    _sqliteLoader = typeof mod?.DatabaseSync === 'function' ? mod.DatabaseSync : null;
  } catch {
    _sqliteLoader = null;
  }
  return _sqliteLoader;
}

function readPbVarint(buf, pos) {
  let val = 0n;
  let shift = 0n;
  while (pos < buf.length && shift < 64n) {
    const b = BigInt(buf[pos++]);
    val |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) return [Number(val), pos];
    shift += 7n;
  }
  return [0, buf.length];
}

function walkPb(buf, cb) {
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = readPbVarint(buf, pos);
    pos = p1;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field <= 0) break;
    if (wire === 0) {
      const [v, p2] = readPbVarint(buf, pos);
      pos = p2;
      cb(field, v, null);
    } else if (wire === 2) {
      const [len, p2] = readPbVarint(buf, pos);
      pos = p2;
      if (len < 0 || pos + len > buf.length) break;
      cb(field, 0, buf.subarray(pos, pos + len));
      pos += len;
    } else if (wire === 1) {
      if (pos + 8 > buf.length) break;
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) break;
      pos += 4;
    } else {
      break;
    }
  }
}

function pbTimestampMs(buf) {
  let seconds = 0;
  let nanos = 0;
  walkPb(buf, (f, v, d) => {
    if (d !== null) return;
    if (f === 1) seconds = v;
    else if (f === 2) nanos = v;
  });
  return seconds > 0 ? seconds * 1000 + nanos / 1e6 : 0;
}

function conversationDbPathForTranscript(transcriptPath, convId) {
  // .../<appDir>/brain/<convId>/.system_generated/logs/transcript.jsonl -> .../<appDir>/conversations/<convId>.db
  const brainDir = dirname(dirname(dirname(dirname(transcriptPath))));
  if (basename(brainDir) !== 'brain') return '';
  const appDir = dirname(brainDir);
  return join(appDir, 'conversations', `${convId}.db`);
}

function readConversationDbTimings(transcriptPath, convId) {
  const dbPath = conversationDbPathForTranscript(transcriptPath, convId);
  if (!dbPath || !existsSync(dbPath)) {
    return { map: null, stamp: 'none' };
  }
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync) {
    return { map: null, stamp: 'nosqlite' };
  }

  let dbSt;
  try {
    dbSt = statSync(dbPath);
  } catch {
    return { map: null, stamp: 'none' };
  }
  let walStamp = 'none';
  try {
    const ws = statSync(`${dbPath}-wal`);
    walStamp = `${ws.mtimeMs}:${ws.size}`;
  } catch {
    walStamp = 'none';
  }
  const stamp = `${dbSt.mtimeMs}:${dbSt.size}:${walStamp}`;
  const cached = dbTimingsCache.get(dbPath);
  if (cached && cached.stamp === stamp) {
    return { map: cached.map, stamp };
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx').all();
    const map = new Map();
    for (const row of rows) {
      const idx = Number(row.idx);
      const raw = row.metadata;
      if (!Number.isFinite(idx) || !raw) continue;
      const buf = raw instanceof Uint8Array ? raw : Buffer.from(raw);
      let startMs = 0;
      let firstMs = 0;
      let endMs = 0;
      walkPb(buf, (f, _v, d) => {
        if (d === null) return;
        if (f === 1) startMs = pbTimestampMs(d);
        else if (f === 6) firstMs = pbTimestampMs(d);
        else if (f === 7) endMs = pbTimestampMs(d);
      });
      if (startMs > 0 && endMs > startMs) {
        map.set(idx, {
          startMs,
          firstMs: firstMs > startMs && firstMs <= endMs ? firstMs : 0,
          endMs,
        });
      }
    }
    if (dbTimingsCache.size >= 32) {
      const oldestKey = dbTimingsCache.keys().next().value;
      if (oldestKey) dbTimingsCache.delete(oldestKey);
    }
    dbTimingsCache.set(dbPath, { stamp, map });
    return { map, stamp };
  } catch {
    return { map: null, stamp: 'err' };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}

function isValidDecodeSample(outputTokens, ttftMs, decodeMs) {
  if (outputTokens <= 0 || decodeMs < MIN_DECODE_MS) return false;
  if (decodeMs < HELD_WINDOW_MS && ttftMs > HELD_SHARE * decodeMs) return false;
  if (outputTokens / (decodeMs / 1000) > MAX_DECODE_TPS) return false;
  return true;
}

function findTranscriptForConversation(convId) {
  if (!convId || typeof convId !== 'string' || !SAFE_CONV_ID_RE.test(convId) || convId.includes('..')) {
    return null;
  }
  for (const { brainDir } of discoverBrainRoots()) {
    const filePath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

function mergeIntervalSeconds(intervals) {
  if (!intervals || intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let totalMs = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      totalMs += Math.max(0, curEnd - curStart);
      curStart = s;
      curEnd = e;
    }
  }
  totalMs += Math.max(0, curEnd - curStart);
  return totalMs / 1000;
}

export function getConversationLiveDetail(convId, { fallbackModel = '', fallbackTitle = '', stepEndTs = null } = {}) {
  const filePath = findTranscriptForConversation(convId);
  if (!filePath) return null;

  let st;
  try {
    st = statSync(filePath);
  } catch {
    return null;
  }

  const { map: dbTimings, stamp: dbStamp } = readConversationDbTimings(filePath, convId);
  const endMap = stepEndTs && typeof stepEndTs === 'object' ? stepEndTs : null;
  const stepEndSig = endMap
    ? Object.entries(endMap)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
    : '';
  const mtimeStamp = `${st.mtimeMs}:${st.size}:${fallbackModel}:${stepEndSig}:${dbStamp}`;
  const cached = liveConvCache.get(filePath);
  if (cached && cached.key === mtimeStamp) {
    return cached.detail;
  }

  let text = '';
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const turns = [];
  let cur = null;
  let curModel = fallbackModel ? normalizeModel(fallbackModel) : '';
  let title = fallbackTitle || '';

  const startTurn = (startedAt, prompt) => {
    cur = {
      turnIndex: turns.length + 1,
      prompt: prompt || '',
      model: curModel || 'unknown',
      startedAt,
      endedAt: startedAt,
      steps: 0,
      input: 0,
      cacheRead: 0,
      output: 0,
      costUsd: 0,
      contextTokens: 0,
      llmSteps: [],
      pendingLlmStep: null,
      toolIntervals: [],
    };
    turns.push(cur);
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    const ts = obj.created_at ? Date.parse(obj.created_at) : NaN;
    const validTs = Number.isFinite(ts) ? ts : 0;

    if (obj.type === 'USER_INPUT') {
      const prompt = extractTitleFromUserInput(obj.content);
      if (!title || title.startsWith('[Subagent]') || title.startsWith('[Swarm ')) {
        if (prompt) title = prompt;
      }
      const changed = extractLastModelChange(obj.content);
      if (changed) curModel = changed;
      startTurn(validTs, prompt);
      continue;
    }

    if (obj.type === 'SYSTEM_MESSAGE' && !title) {
      const extracted = extractTitleFromSystemMessage(obj.content);
      if (extracted) title = extracted;
    }

    if (!cur) {
      startTurn(validTs, title);
    }

    if (validTs && (!cur.startedAt || validTs < cur.startedAt)) cur.startedAt = validTs;
    if (validTs && validTs > cur.endedAt) cur.endedAt = validTs;

    if (obj.type === 'GENERIC') {
      if (cur.pendingLlmStep && validTs >= cur.pendingLlmStep.startTs) {
        cur.pendingLlmStep.nextStepTs = validTs;
        cur.pendingLlmStep = null;
      }
      if (typeof obj.content === 'string') {
        const m = COMPLETED_AT_RE.exec(obj.content);
        if (m) {
          const ct = Date.parse(m[1].trim());
          if (Number.isFinite(ct)) {
            if (ct > cur.endedAt) cur.endedAt = ct;
            if (validTs && ct > validTs) {
              cur.toolIntervals.push([validTs, ct]);
            }
          }
        }
      }
    }

    const hasTokens =
      Object.prototype.hasOwnProperty.call(obj, 'input_tokens') ||
      Object.prototype.hasOwnProperty.call(obj, 'cache_read_tokens') ||
      Object.prototype.hasOwnProperty.call(obj, 'output_tokens');

    if (!hasTokens) continue;
    if (obj.status && obj.status !== 'DONE') continue;

    if (cur.pendingLlmStep && validTs >= cur.pendingLlmStep.startTs) {
      cur.pendingLlmStep.nextStepTs = validTs;
      cur.pendingLlmStep = null;
    }

    if (obj.model) {
      curModel = normalizeModel(obj.model);
    }
    const stepModel = obj.model ? normalizeModel(obj.model) : curModel || 'unknown';
    const inTok = Math.max(0, Number(obj.input_tokens) || 0);
    const crTok = Math.max(0, Number(obj.cache_read_tokens) || 0);
    const outTok = Math.max(0, Number(obj.output_tokens) || 0);
    if (inTok + crTok + outTok === 0) continue;

    const rate = resolveModelRate(stepModel, { ts: validTs || Date.now(), promptTotal: inTok + crTok });
    const cost = calcCostUsd(inTok, crTok, outTok, rate);

    cur.model = stepModel;
    cur.steps += 1;
    cur.input += inTok;
    cur.cacheRead += crTok;
    cur.output += outTok;
    cur.costUsd += cost.total;
    cur.contextTokens = inTok + crTok + outTok;

    const stepIdx = Number(obj.step_index);
    const llmStep = {
      stepIdx: Number.isFinite(stepIdx) ? stepIdx : -1,
      startTs: validTs,
      output: outTok,
      nextStepTs: 0,
    };
    cur.llmSteps.push(llmStep);
    cur.pendingLlmStep = llmStep;
  }

  const activeTurns = turns.filter((t) => t.steps > 0);
  if (activeTurns.length === 0) {
    return null;
  }

  let sessionSteps = 0;
  let sessionInput = 0;
  let sessionCacheRead = 0;
  let sessionOutput = 0;
  let sessionCostUsd = 0;
  let sessionDurationSec = 0;
  let sessionLlmDurationSec = 0;
  let sessionToolDurationSec = 0;
  let sessionMeasuredOutput = 0;
  let sessionDecodeDurationSec = 0;
  let sessionDecodeOutput = 0;
  let sessionTtftSumSec = 0;
  let sessionTtftCount = 0;

  const formattedTurns = activeTurns.map((t, idx) => {
    const isLastTurn = idx === activeTurns.length - 1;
    let turnLlmDurationSec = 0;
    let turnMeasuredOutput = 0;
    let turnDecodeDurationSec = 0;
    let turnDecodeOutput = 0;
    let turnTtftSumSec = 0;
    let turnTtftCount = 0;

    for (let si = 0; si < t.llmSteps.length; si++) {
      const s = t.llmSteps[si];
      const dbStep = dbTimings && s.stepIdx >= 0 ? dbTimings.get(s.stepIdx) : null;
      let startMs = s.startTs;
      let firstMs = 0;
      let endMs = 0;

      if (dbStep && dbStep.startMs > 0 && dbStep.endMs > dbStep.startMs) {
        startMs = dbStep.startMs;
        firstMs = dbStep.firstMs;
        endMs = dbStep.endMs;
      } else if (startMs > 0) {
        if (s.nextStepTs > 0) {
          endMs = s.nextStepTs;
        } else if (endMap && s.stepIdx >= 0 && Number.isFinite(endMap[String(s.stepIdx)])) {
          const rec = endMap[String(s.stepIdx)];
          if (rec > startMs && rec - startMs < MAX_STEP_END_DELTA_MS) {
            endMs = rec;
          }
        } else if (isLastTurn && si === t.llmSteps.length - 1) {
          // Live fallback for the newest turn's final step before Stop hook fires
          if (st.mtimeMs > startMs && st.mtimeMs - startMs < 300_000) {
            endMs = st.mtimeMs;
          }
        }
      }

      if (startMs > 0 && endMs > startMs) {
        turnLlmDurationSec += (endMs - startMs) / 1000;
        turnMeasuredOutput += s.output;
        if (!t.startedAt || startMs < t.startedAt) t.startedAt = startMs;
        if (endMs > t.endedAt) t.endedAt = endMs;

        if (firstMs > startMs && firstMs <= endMs) {
          const ttftMs = firstMs - startMs;
          const decodeMs = endMs - firstMs;
          turnTtftSumSec += ttftMs / 1000;
          turnTtftCount += 1;
          if (isValidDecodeSample(s.output, ttftMs, decodeMs)) {
            turnDecodeDurationSec += decodeMs / 1000;
            turnDecodeOutput += s.output;
          }
        }
      }
    }

    const toolDurationSec = mergeIntervalSeconds(t.toolIntervals);
    const durationSec = t.startedAt && t.endedAt > t.startedAt ? (t.endedAt - t.startedAt) / 1000 : 0;
    const totalInput = t.input + t.cacheRead;
    const cacheHitRate = totalInput > 0 ? t.cacheRead / totalInput : 0;
    const contextWindow = getContextWindow(t.model);
    const contextPct = contextWindow > 0 ? t.contextTokens / contextWindow : 0;
    const turnDecodeTps = turnDecodeDurationSec > 0 ? turnDecodeOutput / turnDecodeDurationSec : 0;
    const turnE2eTps = turnLlmDurationSec > 0 ? turnMeasuredOutput / turnLlmDurationSec : 0;
    const turnTpsMode = turnDecodeTps > 0 ? 'decode' : turnE2eTps > 0 ? 'llm' : 'none';
    const turnTps = turnDecodeTps > 0 ? turnDecodeTps : turnE2eTps;
    const turnAvgTtftSec = turnTtftCount > 0 ? turnTtftSumSec / turnTtftCount : 0;

    sessionSteps += t.steps;
    sessionInput += t.input;
    sessionCacheRead += t.cacheRead;
    sessionOutput += t.output;
    sessionCostUsd += t.costUsd;
    sessionDurationSec += durationSec;
    sessionLlmDurationSec += turnLlmDurationSec;
    sessionToolDurationSec += toolDurationSec;
    sessionMeasuredOutput += turnMeasuredOutput;
    sessionDecodeDurationSec += turnDecodeDurationSec;
    sessionDecodeOutput += turnDecodeOutput;
    sessionTtftSumSec += turnTtftSumSec;
    sessionTtftCount += turnTtftCount;

    return {
      turnIndex: idx + 1,
      prompt: t.prompt,
      model: t.model,
      modelLabel: formatModelLabel(t.model),
      steps: t.steps,
      input: t.input,
      cacheRead: t.cacheRead,
      totalInput,
      output: t.output,
      cacheHitRate,
      costUsd: t.costUsd,
      contextTokens: t.contextTokens,
      contextWindow,
      contextPct,
      durationSec,
      llmDurationSec: turnLlmDurationSec,
      toolDurationSec,
      decodeDurationSec: turnDecodeDurationSec,
      avgTtftSec: turnAvgTtftSec,
      measuredOutput: turnMeasuredOutput,
      decodeOutput: turnDecodeOutput,
      tps: turnTps,
      tpsMode: turnTpsMode,
    };
  });

  const latestTurn = formattedTurns[formattedTurns.length - 1];
  const sessionTotalInput = sessionInput + sessionCacheRead;
  const sessionDecodeTps = sessionDecodeDurationSec > 0 ? sessionDecodeOutput / sessionDecodeDurationSec : 0;
  const sessionE2eTps = sessionLlmDurationSec > 0 ? sessionMeasuredOutput / sessionLlmDurationSec : 0;
  const sessionTpsMode = sessionDecodeTps > 0 ? 'decode' : sessionE2eTps > 0 ? 'llm' : 'none';
  const sessionTps = sessionDecodeTps > 0 ? sessionDecodeTps : sessionE2eTps;
  const sessionAvgTtftSec = sessionTtftCount > 0 ? sessionTtftSumSec / sessionTtftCount : 0;

  const detail = {
    convId,
    title,
    mtimeStamp,
    model: latestTurn.model,
    modelLabel: latestTurn.modelLabel,
    contextTokens: latestTurn.contextTokens,
    contextWindow: latestTurn.contextWindow,
    contextPct: latestTurn.contextPct,
    session: {
      steps: sessionSteps,
      input: sessionInput,
      cacheRead: sessionCacheRead,
      totalInput: sessionTotalInput,
      output: sessionOutput,
      cacheHitRate: sessionTotalInput > 0 ? sessionCacheRead / sessionTotalInput : 0,
      costUsd: sessionCostUsd,
      durationSec: sessionDurationSec,
      llmDurationSec: sessionLlmDurationSec,
      toolDurationSec: sessionToolDurationSec,
      decodeDurationSec: sessionDecodeDurationSec,
      avgTtftSec: sessionAvgTtftSec,
      measuredOutput: sessionMeasuredOutput,
      decodeOutput: sessionDecodeOutput,
      tps: sessionTps,
      tpsMode: sessionTpsMode,
    },
    turns: formattedTurns,
  };

  if (liveConvCache.size >= 32) {
    const oldestKey = liveConvCache.keys().next().value;
    if (oldestKey) liveConvCache.delete(oldestKey);
  }
  liveConvCache.set(filePath, { key: mtimeStamp, detail });
  return detail;
}

export function exportDailyCsv(report) {
  const rate = report.prefs.currency === 'CNY' ? report.prefs.cnyRate : 1;
  const cur = report.prefs.currency;
  const header = [
    'date',
    'steps',
    'input_tokens',
    'cache_read_tokens',
    'output_tokens',
    'total_tokens',
    'cache_hit_pct',
    `est_cost_${cur.toLowerCase()}`,
    `cache_saved_${cur.toLowerCase()}`,
  ].join(',');

  const rows = [...report.daily]
    .reverse()
    .map((d) =>
      [
        d.date,
        d.steps,
        d.input,
        d.cacheRead,
        d.output,
        d.total,
        (d.cacheHitRate * 100).toFixed(2),
        (d.costUsd * rate).toFixed(4),
        (d.cacheSavedUsd * rate).toFixed(4),
      ].join(','),
    );
  return [header, ...rows].join('\n') + '\n';
}
