import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  const runHook = (convId, transcriptPath) =>
    execFileSync(process.execPath, [HOOK_SCRIPT], {
      env,
      input: JSON.stringify({ conversationId: convId, transcriptPath, terminationReason: 'NO_TOOL_CALL' }),
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

test('live conversation detail: multi-turn context, active duration excluding idle gaps, session TPS, and safe convId', () => {
  const h = createHarness();
  const prevRoots = process.env.TOKEN_METER_BRAIN_ROOTS;
  process.env.TOKEN_METER_BRAIN_ROOTS = h.brainDir;
  try {
    const cid = 'conv-live-001';
    const tf = h.mkConv(cid);
    writeFileSync(
      tf,
      [
        // Turn 1: 20s active work, 1,000 output tokens
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-22T01:00:00Z', content: '<USER_REQUEST>Turn 1</USER_REQUEST>' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T01:00:00Z', model: 'gemini-4-neon-xhigh', input_tokens: 10000, cache_read_tokens: 0, output_tokens: 400 }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-22T01:00:10Z', content: 'Created At: 2026-11-22T01:00:10Z\nCompleted At: 2026-11-22T01:00:12Z\nok' }),
        JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T01:00:20Z', model: 'gemini-4-neon-xhigh', input_tokens: 5000, cache_read_tokens: 10000, output_tokens: 600 }),
        // 30-minute idle user pause before Turn 2 (must NOT inflate session active duration!)
        JSON.stringify({ step_index: 4, type: 'USER_INPUT', created_at: '2026-11-22T01:30:00Z', content: '<USER_REQUEST>Turn 2</USER_REQUEST>' }),
        JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T01:30:00Z', model: 'gemini-4-neon-xhigh', input_tokens: 2000, cache_read_tokens: 15000, output_tokens: 1000 }),
        JSON.stringify({ step_index: 6, type: 'GENERIC', status: 'DONE', created_at: '2026-11-22T01:30:20Z', content: 'Created At: 2026-11-22T01:30:20Z\nCompleted At: 2026-11-22T01:30:30Z\nok' }),
        JSON.stringify({ step_index: 7, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T01:30:30Z', model: 'gemini-4-neon-xhigh', input_tokens: 3000, cache_read_tokens: 18000, output_tokens: 1500 }),
      ].join('\n') + '\n',
    );

    // Path traversal convId rejected cleanly
    assert.equal(getConversationLiveDetail('../etc/passwd'), null);

    h.runCli('sync');
    const rep = buildReport({ dataDir: h.dataDir, rangeDays: 7, activeConvId: cid, timeZone: 'UTC' });
    const live = rep.liveConversation;
    assert.ok(live);
    assert.equal(live.turns.length, 2);

    const t1 = live.turns[0];
    const t2 = live.turns[1];
    assert.equal(t1.steps, 2);
    assert.equal(t1.output, 1000);
    assert.equal(t1.durationSec, 20);
    assert.equal(t1.contextTokens, 15600);

    assert.equal(t2.steps, 2);
    assert.equal(t2.input, 5000);
    assert.equal(t2.cacheRead, 33000);
    assert.equal(t2.output, 2500);
    assert.equal(t2.contextTokens, 22500);
    assert.equal(t2.contextWindow, 1_000_000);
    assert.equal(t2.durationSec, 30);

    // Session active duration = 20s + 30s = 50s (excluding 30-min idle gap); TPS = 3500 / 50 = 70 tok/s
    assert.equal(live.session.durationSec, 50);
    assert.equal(live.session.output, 3500);
    assert.ok(Math.abs(live.session.tps - 70) < 1e-6, `expected 70 tok/s, got ${live.session.tps}`);
  } finally {
    if (prevRoots === undefined) delete process.env.TOKEN_METER_BRAIN_ROOTS;
    else process.env.TOKEN_METER_BRAIN_ROOTS = prevRoots;
    h.cleanup();
  }
});
