#!/usr/bin/env node
// Supervisor: the stable MCP stdio endpoint that Claude talks to. All Flow
// logic runs in a child worker (src/worker.js) that can be restarted without
// restarting the MCP client:
//   flow_reload          restart the worker (refuses while a batch runs, unless force)
//   flow_worker_status   worker pid, uptime, last reload
// Set FLOW_WATCH=1 to reload automatically when files under src/ change.
// Chrome is launched detached, so it survives reloads; the new worker
// reattaches to it via CDP.
import { fork } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, 'worker.js');
const CALL_TIMEOUT_MS = 30 * 60 * 1000;

const log = (...a) => process.stderr.write(`[supervisor] ${a.join(' ')}\n`);

let worker = null;
let workerStartedAt = null;
let reloadCount = 0;
let lastReload = null;
let connectedOnce = false; // re-run flow_connect after a reload if the old worker was connected
let seq = 0;
const pending = new Map();
let toolsCache = null;

function startWorker() {
  return new Promise((resolve, reject) => {
    const w = fork(WORKER, [], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], // never let the worker write to our MCP stdout
      env: process.env,
    });
    w.stdout.on('data', d => process.stderr.write(d));
    w.stderr.on('data', d => process.stderr.write(d));
    const onReady = (m) => {
      if (m?.type === 'ready') { w.off('message', onReady); resolve(w); }
    };
    w.on('message', onReady);
    w.on('message', (m) => {
      if (m?.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        clearTimeout(p.timer);
        m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
      }
    });
    w.on('exit', (code, sig) => {
      log(`worker ${w.pid} exited (${code ?? sig})`);
      for (const [id, p] of pending) {
        if (p.worker === w) { clearTimeout(p.timer); p.reject(new Error('Worker exited during the call (reload or crash).')); pending.delete(id); }
      }
      if (worker === w) worker = null;
    });
    w.on('error', reject);
    setTimeout(() => reject(new Error('Worker did not start within 30s')), 30000);
  });
}

async function ensureWorker() {
  if (!worker) {
    worker = await startWorker();
    workerStartedAt = Date.now();
  }
  return worker;
}

async function send(type, extra = {}) {
  const w = await ensureWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Worker call timed out (${type})`)); }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, worker: w });
    w.send({ id, type, ...extra });
  });
}

async function reload({ force = false } = {}) {
  if (worker && !force) {
    const busy = await send('busy').catch(() => null);
    if (busy) {
      return { reloaded: false, reason: `Batch ${busy.batch_id} is running (${busy.done}/${busy.total}). Wait for it, cancel it, or pass force: true (kills it).` };
    }
  }
  const before = JSON.stringify(toolsCache || []);
  if (worker) {
    const old = worker;
    worker = null;
    old.kill('SIGTERM');
    await new Promise(r => { old.once('exit', r); setTimeout(r, 3000); });
  }
  await ensureWorker();
  reloadCount++;
  lastReload = new Date().toISOString();
  toolsCache = await send('list');
  let reconnect = null;
  if (connectedOnce) {
    reconnect = await send('call', { name: 'flow_connect', args: {} })
      .then(r => (r?.isError ? 'failed' : 'ok')).catch(e => `failed: ${e.message}`);
  }
  const changed = JSON.stringify(toolsCache) !== before;
  if (changed) await server.sendToolListChanged().catch(() => {});
  return { reloaded: true, pid: worker.pid, reload_count: reloadCount, tool_list_changed: changed, browser_reconnect: reconnect };
}

const SUPERVISOR_TOOLS = [
  {
    name: 'flow_reload',
    description: 'Restart the Flow worker to load code changes, without restarting Claude. Refuses while a batch is running unless force is true. Chrome stays open; the browser connection is restored.',
    inputSchema: { type: 'object', properties: { force: { type: 'boolean', description: 'Reload even if a batch is running (kills the batch).', default: false } } },
  },
  {
    name: 'flow_worker_status',
    description: 'Supervisor/worker info: worker pid, uptime, reload count, last reload.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const server = new Server(
  { name: 'google-flow-browser-mcp', version: '1.1.0' },
  { capabilities: { tools: { listChanged: true } } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!toolsCache) toolsCache = await send('list');
  return { tools: [...SUPERVISOR_TOOLS, ...toolsCache] };
});

const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'flow_reload') return text(await reload(args || {}));
  if (name === 'flow_worker_status') {
    return text({ supervisor_pid: process.pid, worker_pid: worker?.pid ?? null,
      worker_uptime_s: workerStartedAt ? Math.round((Date.now() - workerStartedAt) / 1000) : null,
      reload_count: reloadCount, last_reload: lastReload, watching: process.env.FLOW_WATCH === '1' });
  }
  try {
    const result = await send('call', { name, args });
    if (name === 'flow_connect' && !result?.isError) connectedOnce = true;
    if (name === 'flow_disconnect') connectedOnce = false;
    return result;
  } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: true, message: e.message, code: 'WORKER' }, null, 2) }], isError: true };
  }
});

if (process.env.FLOW_WATCH === '1') {
  let t = null;
  fs.watch(__dirname, { recursive: true }, (_ev, file) => {
    if (!file || !file.endsWith('.js')) return;
    clearTimeout(t);
    t = setTimeout(() => reload().then(r => log('auto-reload', JSON.stringify(r))).catch(e => log('auto-reload failed', e.message)), 800);
  });
}

const shutdown = () => { try { worker?.kill('SIGTERM'); } catch {} process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('close', shutdown);

await ensureWorker();
await server.connect(new StdioServerTransport());
