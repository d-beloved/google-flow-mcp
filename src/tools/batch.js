// Background batch runner. Runs a manifest of image/video items one at a time
// in the background and records progress to outputs/batches/<id>.json, so the
// MCP call returns at once (no client timeouts) and progress survives restarts
// of the conversation (not of the server).
//
// Manifest (JSON file or inline):
// {
//   "name": "goliath-ep01",
//   "project_name": "David Anthology (Goliath)",
//   "defaults": { "image": { "model": "Nano Banana 2.1", "ratio": "16:9", "download": "2K" },
//                 "video": { "model": "Veo 3.1 - Lite", "ratio": "16:9", "download": "720p" } },
//   "items": [
//     { "label": "S29", "type": "image", "prompt": "...", "ingredients": ["Warrior standing on rocky ridge"] },
//     { "label": "V08", "type": "video", "prompt": "...", "start_frame_label": "S50" }
//   ]
// }
// start_frame_label refers to an earlier item in the same batch (or a "start_frame" title/id).

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getFlowHome } from '../utils/config.js';
import { handleGenerateImage } from './generate-image.js';
import { handleGenerateVideo } from './generate-video.js';
import { handleDownloadLatest } from './download-latest.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { getPage } from '../browser/connect.js';
import { uploadMedia } from '../browser/media.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';

const BATCH_DIR = path.join(getFlowHome(), 'outputs', 'batches');
const batches = new Map(); // id -> state (in memory while running)

function save(state) {
  fs.mkdirSync(BATCH_DIR, { recursive: true });
  fs.writeFileSync(path.join(BATCH_DIR, `${state.id}.json`), JSON.stringify(state, null, 2));
}

function load(id) {
  const f = path.join(BATCH_DIR, `${id}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : null;
}

/** Every media id produced by this batch and earlier batches with the same name. */
function ownedMediaIds(state) {
  const ids = new Set();
  for (const it of state.items) for (const id of it.media_ids || []) ids.add(id);
  try {
    for (const f of fs.readdirSync(BATCH_DIR)) {
      if (!f.startsWith(`${state.name}-`) || !f.endsWith('.json')) continue;
      const old = JSON.parse(fs.readFileSync(path.join(BATCH_DIR, f), 'utf8'));
      for (const it of old.items || []) for (const id of it.media_ids || []) ids.add(id);
    }
  } catch { /* ignore */ }
  return [...ids];
}

/** Media id for a label: this batch first, then earlier batches with the same name (newest first). */
function findLabelMedia(state, label) {
  const hit = state.items.find(x => x.label === label && x.status === 'done' && x.media_ids?.length);
  if (hit) return hit.media_ids[0];
  if (!fs.existsSync(BATCH_DIR)) return null;
  const files = fs.readdirSync(BATCH_DIR).filter(f => f.endsWith('.json'))
    .map(f => path.join(BATCH_DIR, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of files) {
    try {
      const old = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (old.id === state.id || old.name !== state.name) continue;
      const it = old.items?.find(x => x.label === label && x.status === 'done' && x.media_ids?.length);
      if (it) return it.media_ids[0];
    } catch { /* skip unreadable */ }
  }
  return null;
}

function safeName(s) {
  return String(s).replace(/[^\w.-]+/g, '_').slice(0, 80);
}

function moveDownload(dl, dir, label) {
  if (!dl?.path || !fs.existsSync(dl.path)) return dl?.path || null;
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(dl.path) || '';
  let target = path.join(dir, `${safeName(label)}${ext}`);
  if (fs.existsSync(target)) target = path.join(dir, `${safeName(label)}_${Date.now()}${ext}`);
  fs.renameSync(dl.path, target);
  return target;
}

async function runBatch(state) {
  const outDir = path.join(getFlowHome(), 'outputs', safeName(state.name || state.id));
  state.output_dir = outDir;
  state.status = 'running';
  state.started_at = new Date().toISOString();
  save(state);

  for (const item of state.items) {
    if (state.cancel_requested) { state.status = 'cancelled'; break; }
    if (item.status === 'done') continue;
    item.status = 'running';
    item.started_at = new Date().toISOString();
    save(state);
    try {
      const d = { ...(state.defaults?.[item.type] || {}) };
      const common = {
        project_name: state.project_name,
        auto_confirm: true,
        ...d,
        ...item,
      };
      // Never let a later item claim media an earlier item already produced.
      common.exclude_ids = ownedMediaIds(state);
      let result;
      if (item.type === 'download') {
        // Re-download an item made earlier (by label or media id), e.g. after
        // Flow's upscaler failed. Tries each size in order.
        const mediaId = item.media_id || findLabelMedia(state, item.from_label || item.label);
        if (!mediaId) throw new FlowError(ErrorCodes.INVALID_PARAMS, `No media found for ${item.from_label || item.label}.`);
        let r = null;
        for (const size of (item.sizes || [item.size || '2K', '1K'])) {
          r = await handleDownloadLatest({ media_id: mediaId, size, project_name: state.project_name });
          if (r.downloads?.length) { item.size_used = size; break; }
        }
        result = { media_ids: [mediaId], downloads: r?.downloads || [], download_errors: r?.errors };
      } else if (item.type === 'upload') {
        const page = getPage();
        await ensureProjectInContext(page, { name: state.project_name });
        const file = path.isAbsolute(item.file) ? item.file : path.join(getFlowHome(), item.file);
        const tile = await uploadMedia(page, file);
        result = { media_ids: [tile.id], titles: [tile.title], downloads: [] };
      } else if (item.type === 'video') {
        if (item.start_frame_label) {
          const mediaId = findLabelMedia(state, item.start_frame_label);
          if (!mediaId) {
            throw new FlowError(ErrorCodes.INVALID_PARAMS, `Start frame ${item.start_frame_label} not found in this or earlier batches of "${state.name}".`);
          }
          common.start_frame = mediaId;
        }
        result = await handleGenerateVideo(common);
      } else {
        result = await handleGenerateImage(common);
      }
      item.status = 'done';
      item.media_ids = result.media_ids || [];
      item.titles = result.titles || [];
      item.credit_cost = result.credit_cost ?? null;
      item.ingredients_inserted = result.ingredients_inserted;
      item.ingredients_failed = result.ingredients_failed;
      item.files = (result.downloads || []).map((dl, i) =>
        moveDownload(dl, outDir, result.downloads.length > 1 ? `${item.label}_${i + 1}` : item.label));
      item.download_errors = result.download_errors || [];
      const warns = [];
      if (item.ingredients_failed?.length) warns.push(`References not attached: ${item.ingredients_failed.join(', ')}`);
      if (item.download_errors.length) warns.push(`Download failed: ${item.download_errors.map(e => e.error).join('; ').slice(0, 200)}`);
      if (warns.length) item.warning = warns.join(' | ');
    } catch (e) {
      item.status = 'failed';
      item.error = e.message;
      logger.warn('Batch item failed', { batch: state.id, label: item.label, error: e.message });
      if (state.stop_on_error) { state.status = 'stopped'; save(state); return; }
    }
    item.finished_at = new Date().toISOString();
    save(state);
  }
  if (state.status === 'running') state.status = 'finished';
  state.finished_at = new Date().toISOString();
  save(state);
  logger.info('Batch finished', { batch: state.id, status: state.status });
}

function summary(state) {
  const by = s => state.items.filter(i => i.status === s).map(i => i.label);
  const credits = state.items.reduce((n, i) => n + (Number(i.credit_cost) || 0), 0);
  const current = state.items.find(i => i.status === 'running');
  return {
    batch_id: state.id,
    name: state.name,
    status: state.status,
    total: state.items.length,
    done: by('done').length,
    failed: state.items.filter(i => i.status === 'failed').map(i => ({ label: i.label, error: i.error })),
    warnings: state.items.filter(i => i.warning).map(i => ({ label: i.label, warning: i.warning })),
    running: current ? current.label : null,
    pending: by('pending'),
    credits_reported: credits,
    output_dir: state.output_dir,
    manifest: path.join(BATCH_DIR, `${state.id}.json`),
  };
}

/** Start a batch in the background. args: { file } (path to manifest JSON) or { manifest }, plus overrides. */
export async function handleBatchStart(args = {}) {
  let manifest = args.manifest;
  if (args.file) {
    const f = path.isAbsolute(args.file) ? args.file : path.join(getFlowHome(), args.file);
    manifest = JSON.parse(fs.readFileSync(f, 'utf-8'));
  }
  if (!manifest?.items?.length) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Manifest has no items.');
  for (const running of batches.values()) {
    if (running.status === 'running') throw new FlowError(ErrorCodes.JOB_IN_PROGRESS, `Batch ${running.id} is still running.`);
  }
  let items = manifest.items.map(i => ({ type: 'image', ...i, status: 'pending' }));
  if (Array.isArray(args.only)) items = items.filter(i => args.only.includes(i.label));
  if (args.types) items = items.filter(i => args.types.includes(i.type));
  const state = {
    id: `${safeName(manifest.name || 'batch')}-${Date.now().toString(36)}`,
    name: manifest.name,
    project_name: args.project_name || manifest.project_name,
    defaults: manifest.defaults || {},
    stop_on_error: args.stop_on_error ?? manifest.stop_on_error ?? false,
    items,
    created_at: new Date().toISOString(),
    status: 'queued',
  };
  batches.set(state.id, state);
  save(state);
  runBatch(state).catch(e => {
    state.status = 'crashed';
    state.error = e.message;
    save(state);
    logger.error('Batch crashed', { batch: state.id, error: e.message });
  });
  return { ...summary(state), message: `Batch started with ${items.length} item(s). Poll with flow_batch_status.` };
}

export async function handleBatchStatus(args = {}) {
  let state = args.batch_id ? (batches.get(args.batch_id) || load(args.batch_id)) : null;
  if (!state) state = [...batches.values()].pop();
  if (!state) {
    const files = fs.existsSync(BATCH_DIR) ? fs.readdirSync(BATCH_DIR).filter(f => f.endsWith('.json')) : [];
    return { status: 'none', recent: files.slice(-10) };
  }
  const out = summary(state);
  if (args.details) out.items = state.items.map(i => ({ label: i.label, type: i.type, status: i.status, titles: i.titles, files: i.files, credit_cost: i.credit_cost, error: i.error, warning: i.warning }));
  return out;
}

export async function handleBatchCancel(args = {}) {
  const state = args.batch_id ? batches.get(args.batch_id) : [...batches.values()].pop();
  if (!state) return { status: 'none' };
  state.cancel_requested = true;
  save(state);
  return { ...summary(state), message: 'Cancel requested; the current item will finish first.' };
}
