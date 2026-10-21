// Worker process: holds the Flow code and the browser connection.
// Spawned by src/index.js (the supervisor) over IPC; can be killed and
// respawned to pick up code changes. stdout is NOT the MCP channel here.
import { TOOL_DEFINITIONS, callTool } from './core.js';
import { logger } from './utils/logger.js';

async function batchBusy() {
  try {
    const { handleBatchStatus } = await import('./tools/batch.js');
    const s = await handleBatchStatus({});
    return s && s.status === 'running' ? s : null;
  } catch { return null; }
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const reply = (payload) => process.send?.({ id: msg.id, ...payload });
  try {
    if (msg.type === 'list') return reply({ ok: true, result: TOOL_DEFINITIONS });
    if (msg.type === 'busy') return reply({ ok: true, result: await batchBusy() });
    if (msg.type === 'call') return reply({ ok: true, result: await callTool(msg.name, msg.args) });
    reply({ ok: false, error: `Unknown message type ${msg.type}` });
  } catch (e) {
    reply({ ok: false, error: e.message, code: e.code });
  }
});

process.on('uncaughtException', (e) => logger.error('Worker uncaught exception', { error: e.message }));
process.on('unhandledRejection', (e) => logger.error('Worker unhandled rejection', { error: String(e?.message || e) }));
process.send?.({ type: 'ready', pid: process.pid });
