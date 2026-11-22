#!/usr/bin/env node
/**
 * Antigravity Stop lifecycle hook for Token Meter.
 * Reads the hook payload from stdin, incrementally records new token steps
 * from the active conversation transcript into the persistent ledger,
 * and always outputs `{}` so the agent loop is never blocked.
 */
import { readFileSync } from 'node:fs';
import { syncSingleTranscript } from '../lib/ledger.mjs';

function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf-8');
  } catch {
    raw = '';
  }

  try {
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const transcriptPath = typeof payload.transcriptPath === 'string' ? payload.transcriptPath : '';
    const convId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
    const payloadStopAt = Number(payload.stopAt);
    const stopAt = Number.isFinite(payloadStopAt) && payloadStopAt > 0 ? payloadStopAt : Date.now();
    if (transcriptPath) {
      syncSingleTranscript(transcriptPath, { convId, stopAt });
    }
  } catch (err) {
    process.stderr.write(`[token-meter hook] ${err?.message || err}\n`);
  }

  process.stdout.write('{}\n');
}

main();
