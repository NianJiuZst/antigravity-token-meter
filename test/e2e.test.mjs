import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildReport, exportDailyCsv, getConversationLiveDetail, localDateKey } from '../lib/ledger.mjs';
import { calcCostUsd, resolveModelRate } from '../lib/pricing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const HOOK_SCRIPT = join(ROOT, 'hooks', 'record.mjs');
const CLI_SCRIPT = join(ROOT, 'skills', 'token-meter', 'scripts', 'query.mjs');

function createHarness() {
  const tmp = mkdtempSync(join(tmpdir(), 'token-meter-e2e-'));
  const dataDir = join(tmp, 'data');
  const brainDir = join(tmp, 'antigravity', 'brain');
  const env = { ...process.env, TOKEN_METER_DATA_DIR: dataDir, TOKEN_METER_BRAIN_ROOTS: brainDir };

  const mkConv = (convId) => {
    const dir = join(brainDir, convId, '.system_generated', 'logs');
    mkdirSync(dir, { recursive: true });
    return join(dir, 'transcript.jsonl');
  };

  const runCli = (...args) =>
    execFileSync(process.execPath, [CLI_SCRIPT, ...args], { env, encoding: 'utf-8' });

  const runHook = (convId, transcriptPath, extra = {}) =>
    execFileSync(process.execPath, [HOOK_SCRIPT], {
      env,
      input: JSON.stringify({ conversationId: convId, transcriptPath, terminationReason: 'NO_TOOL_CALL', ...extra }),
      encoding: 'utf-8',
    });

  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  return { tmp, dataDir, brainDir, env, mkConv, runCli, runHook, cleanup };
}

test('official Google Gemini API pricing: date transitions and >200K tiers', () => {
  const neon = resolveModelRate('gemini-4-neon-xhigh', { ts: Date.UTC(2026, 10, 22) });
  assert.equal(neon.matchType, 'official');
  assert.deepEqual({ input: neon.input, cacheRead: neon.cacheRead, output: neon.output }, { input: 3, cacheRead: 0.15, output: 15 });

  const carbonIntro = resolveModelRate('gemini-4-carbon-high', { ts: Date.UTC(2026, 10, 30, 23, 59) });
  assert.deepEqual({ input: carbonIntro.input, cacheRead: carbonIntro.cacheRead, output: carbonIntro.output }, { input: 2, cacheRead: 0.1, output: 10 });

  const carbonStd = resolveModelRate('gemini-4-carbon-high', { ts: Date.UTC(2026, 11, 1, 0, 0) });
  assert.deepEqual({ input: carbonStd.input, cacheRead: carbonStd.cacheRead, output: carbonStd.output }, { input: 4, cacheRead: 0.2, output: 20 });

  const flash38Intro = resolveModelRate('gemini-3.8-flash', { ts: Date.UTC(2026, 11, 31) });
  assert.equal(flash38Intro.input, 0.75);
  const flash38Std = resolveModelRate('gemini-3.8-flash', { ts: Date.UTC(2027, 0, 1) });
  assert.equal(flash38Std.input, 1.5);

  const proShort = resolveModelRate('gemini-3.1-pro-preview', { promptTotal: 150_000 });
  assert.equal(proShort.input, 2);
  assert.equal(proShort.output, 12);

  const proLong = resolveModelRate('gemini-3.1-pro-preview', { promptTotal: 250_000 });
  assert.equal(proLong.input, 4);
  assert.equal(proLong.output, 18);

  const cost = calcCostUsd(1_000_000, 1_000_000, 1_000_000, neon);
  assert.ok(Math.abs(cost.total - 18.15) < 1e-6);
  assert.ok(Math.abs(cost.cacheSaved - 2.85) < 1e-6);
});

test('Stop hook + CLI: torn line recovery, dotted model parsing, out-of-order steps, and rewrite updates', () => {
  const h = createHarness();
  try {
    const t1 = h.mkConv('conv-torn-1');
    writeFileSync(
      t1,
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-01T04:30:00Z',
        content:
          '<USER_REQUEST>\nFix parser\n</USER_REQUEST>\nThe user changed setting `Model Selection` from None to Gemini 2.5 Pro. No need to comment.',
      }) +
        '\n' +
        '{"step_index":2,"type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-01T04:30:05Z","input_tokens":100000,"cache_read_tok',
    );

    assert.equal(h.runHook('conv-torn-1', t1).trim(), '{}');
    let rep = JSON.parse(h.runCli('summary', '--days', '0', '--json', '--no-sync'));
    assert.equal(rep.allTime.totalEvents, 0);

    appendFileSync(
      t1,
      'ens":200000,"output_tokens":50000}\n' +
        JSON.stringify({
          step_index: 1,
          type: 'CHECKPOINT',
          status: 'DONE',
          created_at: '2026-11-01T04:30:06Z',
          input_tokens: 50_000,
          cache_read_tokens: 0,
          output_tokens: 10_000,
        }) +
        '\n',
    );
    assert.equal(h.runHook('conv-torn-1', t1).trim(), '{}');

    // DST-aware date bucketing for America/New_York on DST transition day
    assert.equal(localDateKey(Date.parse('2026-11-01T04:30:00Z'), 'America/New_York'), '2026-11-01');
    rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'America/New_York' });
    assert.equal(rep.allTime.totalEvents, 2);
    assert.equal(rep.models[0].model, 'gemini-2.5-pro');
    assert.equal(rep.models[0].matchType, 'official');
    assert.equal(rep.sessions[0].title, 'Fix parser');
    assert.equal(rep.daily[0].date, '2026-11-01');
    assert.ok(rep.etag.includes(`today=${rep.todayDate}`));
  } finally {
    h.cleanup();
  }
});

test('parent-model inheritance, concurrent Stop hooks, archive preservation, and >730-day CSV', async () => {
  const h = createHarness();
  try {
    const pId = '11111111-1111-1111-1111-111111111111';
    const cId = '22222222-2222-2222-2222-222222222222';
    const oldId = '33333333-3333-3333-3333-333333333333';

    const tParent = h.mkConv(pId);
    writeFileSync(
      tParent,
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-18T08:00:00Z',
        content: '<USER_REQUEST>Parent task</USER_REQUEST>\nModel Selection` from None to Gemini 4 Carbon (High).',
      }) +
        '\n' +
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-18T08:00:05Z',
          input_tokens: 1_000_000,
          cache_read_tokens: 0,
          output_tokens: 0,
        }) +
        '\n',
    );

    const tChild = h.mkConv(cId);
    writeFileSync(
      tChild,
      JSON.stringify({
        step_index: 0,
        type: 'SYSTEM_MESSAGE',
        created_at: '2026-11-18T08:01:00Z',
        content: `<SYSTEM_MESSAGE>\n[Message] sender=${pId} content=Your assignment (recorded on the board as #2 for @worker-1):\n\nFix tests\n</SYSTEM_MESSAGE>`,
      }) +
        '\n' +
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-18T08:01:05Z',
          input_tokens: 1_000_000,
          cache_read_tokens: 0,
          output_tokens: 0,
        }) +
        '\n',
    );

    const tOld = h.mkConv(oldId);
    writeFileSync(
      tOld,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2023-01-01T12:00:00Z',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 1_000_000,
        cache_read_tokens: 0,
        output_tokens: 0,
      }) + '\n',
    );

    // Fire 4 concurrent Stop hooks
    await Promise.all(
      [
        [pId, tParent],
        [cId, tChild],
        [cId, tChild],
        [oldId, tOld],
      ].map(
        ([cid, path]) =>
          new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [HOOK_SCRIPT], { env: h.env });
            let out = '';
            child.stdout.on('data', (d) => (out += d));
            child.on('exit', (code) =>
              code === 0 && out.trim() === '{}' ? resolve() : reject(new Error(`hook exit ${code}: ${out}`)),
            );
            child.stdin.end(JSON.stringify({ conversationId: cid, transcriptPath: path }));
          }),
      ),
    );

    // Delete child transcript and run full rescan: archived events & metadata must survive
    rmSync(join(h.brainDir, cId), { recursive: true, force: true });
    h.runCli('sync', '--full');

    const rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(rep.allTime.totalEvents, 3);
    assert.equal(rep.period.activeDays, 2);
    assert.equal(rep.models.some((m) => m.model === 'unknown'), false, 'child inherited gemini-4-carbon-high');
    const archivedChild = rep.sessions.find((s) => s.convId === cId);
    assert.ok(archivedChild && archivedChild.title.includes('@worker-1'));

    // Currency switch & >730-day CSV retains both 2023 and 2026
    h.runCli('set-currency', 'CNY');
    const repCny = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    const csv = exportDailyCsv(repCny);
    assert.ok(csv.includes('est_cost_cny'));
    assert.ok(csv.includes('2023-01-01') && csv.includes('2026-11-18'));
  } finally {
    h.cleanup();
  }
});

test('live conversation detail: step-level LLM TPS excluding tool/approval waits, Stop hook endTs, and safe convId', () => {
  const h = createHarness();
  const prevRoots = process.env.TOKEN_METER_BRAIN_ROOTS;
  process.env.TOKEN_METER_BRAIN_ROOTS = h.brainDir;
  try {
    const cid = 'conv-live-001';
    const tf = h.mkConv(cid);
    // Turn 1:
    // - step 1 (LLM): 01:00:00Z -> 01:00:10Z (10s, 400 out)
    // - step 2 & 3 (parallel tools): [01:00:10Z..01:00:15Z] and [01:00:12Z..01:00:20Z] => merged tool duration 10s
    // - step 4 (final LLM): 01:00:20Z -> Stop hook at 01:00:30Z (10s, 800 out)
    writeFileSync(
      tf,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-22T01:00:00Z', content: '<USER_REQUEST>Turn 1</USER_REQUEST>' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T01:00:00Z', model: 'gemini-4-neon-xhigh', input_tokens: 10000, cache_read_tokens: 0, output_tokens: 400 }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-22T01:00:10Z', content: 'Created At: 2026-11-22T01:00:10Z\nCompleted At: 2026-11-22T01:00:15Z\nok' }),
        JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'DONE', created_at: '2026-11-22T01:00:12Z', content: 'Created At: 2026-11-22T01:00:12Z\nCompleted At: 2026-11-22T01:00:20Z\nok' }),
        JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T01:00:20Z', model: 'gemini-4-neon-xhigh', input_tokens: 5000, cache_read_tokens: 10000, output_tokens: 800 }),
      ].join('\n') + '\n',
    );

    // Path traversal convId rejected cleanly
    assert.equal(getConversationLiveDetail('../etc/passwd'), null);

    // Simulate sidecar scanning BEFORE Stop hook fires, then Stop hook stamping exact endTs
    h.runCli('sync');
    assert.equal(h.runHook(cid, tf, { stopAt: Date.parse('2026-11-22T01:00:30Z') }).trim(), '{}');

    // Append Turn 2 after a 30-minute idle gap (must NOT inflate session active duration!):
    // - step 6 (LLM): 01:30:00Z -> 01:30:20Z (20s, 1000 out)
    // - step 7 (slow tool / approval wait): 01:30:20Z -> 01:31:00Z (40s tool wait)
    // - step 8 (final LLM, unmeasured — no Stop hook yet): 01:31:00Z (1500 out)
    appendFileSync(
      tf,
      [
        JSON.stringify({ step_index: 5, type: 'USER_INPUT', created_at: '2026-11-22T01:30:00Z', content: '<USER_REQUEST>Turn 2</USER_REQUEST>' }),
        JSON.stringify({ step_index: 6, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T01:30:00Z', model: 'gemini-4-neon-xhigh', input_tokens: 2000, cache_read_tokens: 15000, output_tokens: 1000 }),
        JSON.stringify({ step_index: 7, type: 'GENERIC', status: 'DONE', created_at: '2026-11-22T01:30:20Z', content: 'Created At: 2026-11-22T01:30:20Z\nCompleted At: 2026-11-22T01:31:00Z\nok' }),
        JSON.stringify({ step_index: 8, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T01:31:00Z', model: 'gemini-4-neon-xhigh', input_tokens: 3000, cache_read_tokens: 18000, output_tokens: 1500 }),
      ].join('\n') + '\n',
    );

    // Full rescan must preserve Turn 1's recorded Stop hook endTs
    h.runCli('sync', '--full');

    let rep = buildReport({ dataDir: h.dataDir, rangeDays: 7, activeConvId: cid, timeZone: 'UTC' });
    let live = rep.liveConversation;
    assert.ok(live);
    assert.equal(live.turns.length, 2);

    const t1 = live.turns[0];
    const t2 = live.turns[1];
    assert.equal(t1.steps, 2);
    assert.equal(t1.output, 1200);
    assert.equal(t1.durationSec, 30);
    assert.equal(t1.llmDurationSec, 20);
    assert.equal(t1.toolDurationSec, 10);
    assert.equal(t1.measuredOutput, 1200);
    assert.ok(Math.abs(t1.tps - 60) < 1e-6, `expected Turn 1 TPS 60, got ${t1.tps}`);
    assert.equal(t1.contextTokens, 15800);

    // Turn 2 before Stop hook: only step 6 (1000 out / 20s = 50 tok/s) is measured; 40s tool wait excluded, unmeasured step 8 excluded from numerator
    assert.equal(t2.steps, 2);
    assert.equal(t2.input, 5000);
    assert.equal(t2.cacheRead, 33000);
    assert.equal(t2.output, 2500);
    assert.equal(t2.contextTokens, 22500);
    assert.equal(t2.contextWindow, 1_000_000);
    assert.equal(t2.durationSec, 60);
    assert.equal(t2.llmDurationSec, 20);
    assert.equal(t2.toolDurationSec, 40);
    assert.equal(t2.measuredOutput, 1000);
    assert.ok(Math.abs(t2.tps - 50) < 1e-6, `expected Turn 2 TPS 50, got ${t2.tps}`);

    // Session TPS aligns measuredOutput (1200 + 1000 = 2200) / llmDurationSec (20 + 20 = 40) = 55 tok/s
    assert.equal(live.session.durationSec, 90);
    assert.equal(live.session.llmDurationSec, 40);
    assert.equal(live.session.toolDurationSec, 50);
    assert.equal(live.session.measuredOutput, 2200);
    assert.equal(live.session.output, 3700);
    assert.ok(Math.abs(live.session.tps - 55) < 1e-6, `expected 55 tok/s, got ${live.session.tps}`);

    // Now fire Stop hook for Turn 2 at 01:31:15Z (15s for 1500 out => 100 tok/s on final step)
    const prevEtag = rep.etag;
    assert.equal(h.runHook(cid, tf, { stopAt: Date.parse('2026-11-22T01:31:15Z') }).trim(), '{}');
    rep = buildReport({ dataDir: h.dataDir, rangeDays: 7, activeConvId: cid, timeZone: 'UTC' });
    assert.notEqual(rep.etag, prevEtag, 'ETag must invalidate when Stop hook records stepEndTs');
    live = rep.liveConversation;
    // Turn 2: measuredOutput = 1000 + 1500 = 2500, llmDurationSec = 20 + 15 = 35s
    assert.equal(live.turns[1].durationSec, 75);
    assert.equal(live.turns[1].llmDurationSec, 35);
    assert.equal(live.turns[1].measuredOutput, 2500);
    assert.ok(Math.abs(live.turns[1].tps - 2500 / 35) < 1e-6);
    // Session: measuredOutput = 3700, llmDurationSec = 55s
    assert.equal(live.session.llmDurationSec, 55);
    assert.equal(live.session.measuredOutput, 3700);
    assert.equal(live.session.tpsMode, 'llm');
    assert.ok(Math.abs(live.session.tps - 3700 / 55) < 1e-6);
  } finally {
    if (prevRoots === undefined) delete process.env.TOKEN_METER_BRAIN_ROOTS;
    else process.env.TOKEN_METER_BRAIN_ROOTS = prevRoots;
    h.cleanup();
  }
});

function encodePbVarint(n) {
  let v = BigInt(n);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function encodePbFieldBytes(fieldNum, bytes) {
  return Buffer.concat([encodePbVarint((fieldNum << 3) | 2), encodePbVarint(bytes.length), bytes]);
}

function encodePbTimestamp(ms) {
  const sec = Math.floor(ms / 1000);
  const nanos = Math.round((ms - sec * 1000) * 1e6);
  const parts = [Buffer.concat([encodePbVarint((1 << 3) | 0), encodePbVarint(sec)])];
  if (nanos > 0) parts.push(Buffer.concat([encodePbVarint((2 << 3) | 0), encodePbVarint(nanos)]));
  return Buffer.concat(parts);
}

function encodeStepMeta(startMs, firstMs, endMs) {
  const parts = [encodePbFieldBytes(1, encodePbTimestamp(startMs))];
  if (firstMs) parts.push(encodePbFieldBytes(6, encodePbTimestamp(firstMs)));
  if (endMs) parts.push(encodePbFieldBytes(7, encodePbTimestamp(endMs)));
  return Buffer.concat(parts);
}

test('SQLite conversation db timings: pure decode TPS excluding TTFT and held-burst filtering', () => {
  const req = createRequire(import.meta.url);
  let DatabaseSync;
  try {
    ({ DatabaseSync } = req('node:sqlite'));
  } catch {
    return; // skip on Node < 22.5 without node:sqlite
  }

  const h = createHarness();
  const prevRoots = process.env.TOKEN_METER_BRAIN_ROOTS;
  process.env.TOKEN_METER_BRAIN_ROOTS = h.brainDir;
  try {
    const cid = 'conv-sqlite-001';
    const tf = h.mkConv(cid);
    const t0 = Date.parse('2026-11-22T07:00:00Z');
    writeFileSync(
      tf,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-22T07:00:00Z', content: '<USER_REQUEST>Check decode TPS</USER_REQUEST>' }),
        // Step 1: held burst (TTFT 18.1s, decode 0.1s, 260 out => 2600 tok/s burst — must be filtered!)
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T07:00:00Z', model: 'gemini-4-neon-high', input_tokens: 3000, cache_read_tokens: 200000, output_tokens: 260 }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-22T07:00:18Z', content: 'Created At: 2026-11-22T07:00:18Z\nCompleted At: 2026-11-22T07:00:21Z\nok' }),
        // Step 3: normal streamed reply (TTFT 19.0s, decode 4.0s, 500 out => 125.0 tok/s!)
        JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T07:00:21Z', model: 'gemini-4-neon-high', input_tokens: 2500, cache_read_tokens: 204000, output_tokens: 500 }),
      ].join('\n') + '\n',
    );

    const convDir = join(h.tmp, 'antigravity', 'conversations');
    mkdirSync(convDir, { recursive: true });
    const db = new DatabaseSync(join(convDir, `${cid}.db`));
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB)');
    const ins = db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)');
    ins.run(1, encodeStepMeta(t0, t0 + 18_100, t0 + 18_200));
    ins.run(3, encodeStepMeta(t0 + 21_000, t0 + 40_000, t0 + 44_000));
    db.close();

    h.runCli('sync');
    const rep = buildReport({ dataDir: h.dataDir, rangeDays: 7, activeConvId: cid, timeZone: 'UTC' });
    const live = rep.liveConversation;
    assert.ok(live);
    assert.equal(live.turns.length, 1);

    const turn = live.turns[0];
    assert.equal(turn.tpsMode, 'decode');
    assert.equal(turn.decodeOutput, 500, 'held burst step 1 must be excluded from decodeOutput');
    assert.ok(Math.abs(turn.decodeDurationSec - 4.0) < 1e-6);
    assert.ok(Math.abs(turn.tps - 125.0) < 1e-6, `expected 125.0 tok/s, got ${turn.tps}`);
    assert.ok(Math.abs(turn.avgTtftSec - 18.55) < 1e-6, `expected avg TTFT 18.55s, got ${turn.avgTtftSec}`);
    assert.ok(Math.abs(turn.llmDurationSec - 41.2) < 1e-6);
    assert.ok(Math.abs(turn.toolDurationSec - 3.0) < 1e-6);
    assert.equal(live.session.tpsMode, 'decode');
    assert.ok(Math.abs(live.session.tps - 125.0) < 1e-6);
  } finally {
    if (prevRoots === undefined) delete process.env.TOKEN_METER_BRAIN_ROOTS;
    else process.env.TOKEN_METER_BRAIN_ROOTS = prevRoots;
    h.cleanup();
  }
});
