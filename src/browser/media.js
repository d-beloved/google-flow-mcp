// Media tiles and downloads in a Flow project (verified 2026-10-21).
//
//   flow-grid-tile-container[role=group][aria-label="<title>"]  (right-click → menu)
//     img|video[data-media-id="<uuid>"]
//   Context menu: Favourite, Reuse prompt, Animate, Add to prompt, Download ▸, ...
//   Download ▸ (images): "1K Original size", "2K Upscaled", "4K Upscaled"
//   Download ▸ (videos): "270p Animated GIF", "720p Original size", "1080p Upscaled", "4K Upscaled" (plan-gated)
//   Upscaling shows a snackbar "Upscaling your image. Download will start
//   automatically." then "Upscaling complete. Your image has been downloaded!"

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getBrowser } from './connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { getOutputDir } from '../utils/file-manager.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

const MENU_ITEM = '.cdk-overlay-container [role="menuitem"]';

// Image tiles carry img[data-media-id]; video tiles (flow-video-tile) don't —
// they only have img.thumbnail. Key = media id, else "thumb:<thumbnail src>".
const TILE = 'flow-grid-tile-container';

/** All media tiles on the page, in DOM order (newest first in the default grid). */
export async function listMedia(page) {
  return page.evaluate((TILE) => [...document.querySelectorAll(TILE)].map((tile, index) => {
    const idEl = tile.querySelector('[data-media-id]');
    const isVideo = !!tile.querySelector('flow-video-tile');
    const img = idEl?.tagName === 'IMG' ? idEl : tile.querySelector('img.thumbnail, img');
    const src = img?.currentSrc || img?.src || '';
    const ready = !!img && img.complete && img.naturalWidth > 0;
    const text = (tile.innerText || '').trim();
    return {
      // Video thumbnails on flow-content.google carry a stable media uuid in the
      // path (/image/<uuid>?Expires=...); older asb/ URLs are signed and unstable.
      id: idEl?.getAttribute('data-media-id')
        || ((src.match(/flow-content\.google\/[a-z]+\/([0-9a-f-]{36})/i) || [])[1] ? `vid:${src.match(/flow-content\.google\/[a-z]+\/([0-9a-f-]{36})/i)[1]}` : null)
        || (src ? `thumb:${src}` : `tile:${index}:${tile.getAttribute('aria-label') || ''}`),
      failed: !img && /^\s*(warning\s*)?Failed\b/i.test(text) ? text.replace(/\s+/g, ' ').replace(/^warning /, '').slice(0, 120) : null,
      type: isVideo ? 'video' : 'image',
      title: tile.getAttribute('aria-label') || '',
      src,
      ready,
      index,
    };
  }).filter((m, i, a) => a.findIndex(x => x.id === m.id) === i), TILE);
}

// Open a tile's context menu and wait for an item. Flow's menu animates in, and
// Playwright's isVisible() does not wait, so poll with waitFor and retry the
// right-click (a tile still finishing its generation can show a short menu).
async function openTileMenuItem(page, tile, re, { tries = 3, timeoutMs = 5000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await page.keyboard.press('Escape').catch(() => {});
    await tile.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const item = page.locator(MENU_ITEM).filter({ hasText: re }).first();
    // Nov 2026: right-click no longer opens the menu; hovering a tile shows a
    // small toolbar (favourite, reuse, more ⋮) and the menu is behind "more".
    // Try the ⋮ button first, then fall back to the old right-click.
    await tile.hover({ timeout: 4000 }).catch(() => {});
    const more = tile.locator('button').filter({ hasText: /more_vert|more_horiz/ })
      .or(tile.locator('button[aria-label*="ore" i], button[aria-label*="ption" i], button[aria-label*="enu" i]')).last();
    if (await more.waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false)) {
      await more.click({ timeout: 4000 }).catch(() => more.evaluate(el => el.click(), undefined, { timeout: 3000 }).catch(() => {}));
      try { await item.waitFor({ state: 'visible', timeout: timeoutMs }); return item; } catch {}
      await page.keyboard.press('Escape').catch(() => {});
    }
    await tile.click({ button: 'right', timeout: 4000 }).catch(() => {});
    try { await item.waitFor({ state: 'visible', timeout: timeoutMs }); return item; } catch {}
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(3000);
  }
  return null;
}

async function tileLocator(page, mediaId) {
  let m = (await listMedia(page)).find(x => x.id === mediaId);
  if (!m && !String(mediaId).startsWith('thumb:')) m = await findTile(page, { id: mediaId });
  return m ? { loc: page.locator(TILE).nth(m.index), media: m } : null;
}

const SCROLLER = '.cdk-virtual-scrollable.page-container';

/** Scroll the (virtual) media grid to the top so the newest tiles are rendered. */
export async function scrollGridToTop(page) {
  await page.evaluate((sel) => { const sc = document.querySelector(sel); if (sc) sc.scrollTop = 0; }, SCROLLER).catch(() => {});
  await page.waitForTimeout(400);
}

// Stable identity: image media id, else type + title (video thumbnails are signed URLs).
// Identity: media id (images) or vid:<uuid> (videos); otherwise type + title + an
// index-free fallback. Titles repeat (re-generations of the same prompt), so
// they are only a last resort.
const stableKey = m => (m.id && !m.id.startsWith('thumb:') && !m.id.startsWith('tile:')) ? m.id : `${m.type}|${m.title}`;

/**
 * Wait until `count` new, loaded tiles appear at the top of the grid.
 * The grid is a CDK virtual scroller (only ~20-30 tiles are in the DOM), so we
 * can't diff the whole project. New results are inserted at the top: the new
 * tiles are those rendered before the first tile we saw before clicking Generate.
 * `before` is the listMedia() array captured (at scroll top) before Generate.
 */
export async function waitForNewMedia(page, before, { count = 1, timeoutMs = 180000, type, exclude } = {}) {
  const beforeKeys = new Set((before || []).map(b => (typeof b === 'string' ? b : stableKey(b))));
  // A tile can change key between snapshots (a video's thumbnail loads after the
  // snapshot, so "video|title" becomes "vid:<uuid>"). Remember titles of tiles
  // whose key was not stable, and never return ids the caller already owns.
  const unstableTitles = new Set((before || []).filter(b => typeof b !== 'string' && stableKey(b) !== b.id)
    .map(b => `${b.type}|${b.title}`));
  const excluded = new Set(exclude || []);
  const isOld = m => beforeKeys.has(stableKey(m)) || excluded.has(m.id)
    || (stableKey(m) !== m.id && unstableTitles.has(`${m.type}|${m.title}`));
  // Nov 2026: video tiles now carry signed (unstable) thumbnail URLs, so their key is
  // "video|<title>". A new clip whose title repeats an older one ("Old man watching
  // flame") then looks old and the wait times out. Count keys: if a key now appears
  // more often than before, its topmost extra copies are new.
  const beforeCount = new Map();
  for (const b of before || []) { if (typeof b === 'string') continue; const k = stableKey(b); beforeCount.set(k, (beforeCount.get(k) || 0) + 1); }
  const extraByCount = (media) => {
    const now = new Map();
    for (const m of media) { const k = stableKey(m); now.set(k, (now.get(k) || 0) + 1); }
    const out = [];
    const taken = new Map();
    for (const m of media) {
      const k = stableKey(m);
      const extra = (now.get(k) || 0) - (beforeCount.get(k) || 0);
      if (extra > 0 && (taken.get(k) || 0) < extra && !excluded.has(m.id)) { out.push(m); taken.set(k, (taken.get(k) || 0) + 1); }
    }
    return out;
  };
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < timeoutMs) {
    await scrollGridToTop(page);
    const media = await listMedia(page).catch(() => []);
    const firstOld = media.findIndex(isOld);
    let fresh = (firstOld === -1 ? (beforeKeys.size ? [] : media) : media.slice(0, firstOld))
      .filter(m => (!type || m.type === type) && !isOld(m));
    if (!fresh.length) {
      const byCount = extraByCount(media).filter(m => !type || m.type === type);
      if (byCount.length) fresh = byCount;
    }
    const ready = fresh.filter(m => m.ready);
    if (ready.length >= count) return ready.slice(0, count);
    // Flow shows a "Failed — Failed to load image" tile when a generation fails.
    const failedTile = (firstOld === -1 ? media : media.slice(0, firstOld)).find(m => m.failed);
    if (failedTile && ready.length < count) {
      await takeScreenshot(page, 'generation-failed-tile');
      throw new FlowError(ErrorCodes.GENERATION_TIMEOUT, `Flow: ${failedTile.failed}`);
    }

    const failed = await page.evaluate(() => {
      const t = document.body.innerText;
      const m = t.match(/(Something went wrong[^\n]*|couldn['’]t generate[^\n]*|Generation failed[^\n]*|violates?[^\n]*polic[^\n]*)/i);
      return m ? m[0] : null;
    }).catch(() => null);
    if (failed && !fresh.length) {
      await takeScreenshot(page, 'generation-failed');
      throw new FlowError(ErrorCodes.GENERATION_TIMEOUT, `Flow reported: ${failed}`);
    }
    if (Date.now() - lastLog > 30000) {
      lastLog = Date.now();
      logger.info('Waiting for new media', { elapsedS: Math.round((Date.now() - start) / 1000), fresh: fresh.length, ready: ready.length });
    }
    await page.waitForTimeout(2000);
  }
  await takeScreenshot(page, 'generation-timeout');
  throw new FlowError(ErrorCodes.GENERATION_TIMEOUT,
    `No new media appeared within ${Math.round(timeoutMs / 1000)}s. Check the Flow project.`);
}

/**
 * Bring a tile into the DOM by scrolling the virtual grid. Match by media id
 * (images) or exact title. Returns the media entry (with .index) or null.
 */
export async function findTile(page, { id, title }) {
  await scrollGridToTop(page);
  for (let i = 0; i < 200; i++) {
    const media = await listMedia(page).catch(() => []);
    const m = media.find(x => (id && (x.id === id || (id.length >= 8 && x.id.startsWith(id)))) || (title && x.title === title));
    if (m) {
      await page.locator(TILE).nth(m.index).scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(300);
      const again = (await listMedia(page)).find(x => (id && (x.id === id || (id.length >= 8 && x.id.startsWith(id)))) || (title && x.title === title));
      return again || m;
    }
    const atEnd = await page.evaluate((sel) => {
      const sc = document.querySelector(sel);
      if (!sc) return true;
      const end = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
      sc.scrollTop += Math.max(200, sc.clientHeight * 0.7);
      return end;
    }, SCROLLER);
    await page.waitForTimeout(500);
    if (atEnd) break;
  }
  return null;
}

async function snackbarText(page) {
  return page.evaluate(() => [...document.querySelectorAll('mat-snack-bar-container, .mat-mdc-snack-bar-container, [role="alert"], [role="status"]')]
    .map(e => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ')).catch(() => '');
}

function snapshotDir(dir) {
  return new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
}

/**
 * Download one media tile at the given size via the tile's context menu.
 * size: "1K" | "2K" | "4K" for images (2K/4K are upscaled by Flow). For videos,
 * pass the label prefix Flow shows (e.g. "720p"); omit to take the first option.
 * Returns { path, filename, size, mediaId }.
 */
export async function downloadMedia(page, mediaId, { size = '2K', type = 'image', timeoutMs = 300000 } = {}) {
  const found = await tileLocator(page, mediaId);
  if (!found || !(await found.loc.isVisible({ timeout: 10000 }).catch(() => false))) {
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Media ${mediaId} is not visible in this project.`);
  }
  const tile = found.loc;
  type = found.media.type || type;

  const outDir = getOutputDir(type);
  const before = snapshotDir(outDir);
  const browser = getBrowser();
  let cdp = null;
  try {
    cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outDir, eventsEnabled: true });
  } catch (e) {
    logger.warn('Could not redirect Chrome downloads; falling back to the page download event', { error: e.message });
    cdp = null;
  }

  // Playwright may also surface the download; save it if the CDP path didn't apply.
  let pwDownload = null;
  const onDownload = d => { pwDownload = d; };
  page.on('download', onDownload);

  try {
    const dl = await openTileMenuItem(page, tile, /Download/);
    if (!dl) {
      await takeScreenshot(page, 'download-menu-missing');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Tile menu has no "Download" item.');
    }
    await dl.click({ timeout: 5000 }).catch(() => dl.evaluate(el => el.click(), undefined, { timeout: 3000 }));
    await page.waitForTimeout(600);

    const sub = page.locator(`${MENU_ITEM}:not(:has-text("Download"))`);
    const labels = (await sub.allTextContents()).map(t => t.replace(/\s+/g, ' ').trim());
    const sizeRe = size ? new RegExp(`^${size.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
    // Submenu items come after the main menu's items; pick from the last menu panel.
    const panel = page.locator('.cdk-overlay-container [role="menu"]').last();
    const options = panel.locator('[role="menuitem"]');
    const optLabels = (await options.allTextContents()).map(t => t.replace(/\s+/g, ' ').trim());
    const disabled = await options.evaluateAll(els => els.map(e => e.getAttribute('aria-disabled') === 'true' || e.disabled));
    const idx = sizeRe ? optLabels.findIndex(t => sizeRe.test(t)) : disabled.findIndex(d => !d);
    if (idx >= 0 && disabled[idx]) {
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        `"${optLabels[idx]}" is greyed out for this account. Enabled: ${optLabels.filter((_, i) => !disabled[i]).join(', ')}`);
    }
    if (idx < 0) {
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        `Download size "${size}" not offered. Options: ${optLabels.join(', ') || labels.join(', ')}`);
    }
    logger.info('Downloading media', { mediaId, option: optLabels[idx] });
    await options.nth(idx).click();

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await page.waitForTimeout(1000);
      const snack = await snackbarText(page);
      if (/not available|unable|couldn['’]t|failed|error/i.test(snack) && !/complete/i.test(snack)) {
        throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Flow: ${snack}`);
      }
      const added = [...snapshotDir(outDir)].filter(f => !before.has(f) && !f.endsWith('.crdownload') && !f.startsWith('.'));
      if (added.length) {
        const file = path.join(outDir, added[0]);
        // Wait for the file size to settle.
        let prev = -1;
        for (let i = 0; i < 10; i++) {
          const s = fs.statSync(file).size;
          if (s > 0 && s === prev) break;
          prev = s;
          await page.waitForTimeout(500);
        }
        return { path: file, filename: added[0], size: optLabels[idx], mediaId };
      }
      // Fallback only: if Chrome's own download (redirected by CDP above) hasn't
      // shown up after a while, try Playwright's copy. Never fail on it — the
      // CDP path usually wins and Playwright's temp file is then missing.
      if (pwDownload && Date.now() - start > 20000) {
        const name = pwDownload.suggestedFilename() || `${mediaId}.${type === 'video' ? 'mp4' : 'png'}`;
        const file = path.join(outDir, name);
        try {
          await pwDownload.saveAs(file);
          return { path: file, filename: name, size: optLabels[idx], mediaId };
        } catch (e) {
          logger.warn('Playwright download copy failed; still waiting for the Chrome download', { error: e.message });
          pwDownload = null;
        }
      }
    }
    await takeScreenshot(page, 'download-timeout');
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
      `Download did not finish within ${Math.round(timeoutMs / 1000)}s. Last Flow message: ${await snackbarText(page)}`);
  } finally {
    // Dismiss Flow's "Upscaling complete" snackbar so it doesn't linger over the UI.
    await page.locator('mat-snack-bar-container button, .mat-mdc-snack-bar-container button')
      .filter({ hasText: /Dismiss/i }).first().click({ timeout: 1500 }).catch(() => {});
    page.off('download', onDownload);
    if (cdp) {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
}

/** Remove every reference currently attached to the prompt (ingredient bar ×). */
export async function clearPromptIngredients(page) {
  const btns = page.locator('.prompt-ingredient-bar button[aria-label="Ingredient"]');
  for (let i = 0; i < 20; i++) {
    const n = await btns.count().catch(() => 0);
    if (!n) return;
    await btns.first().click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

/**
 * Attach a project item to the prompt via its tile menu ("Add to prompt").
 * Accepts a media id from a previous result, or an exact tile title.
 * Returns true if the ingredient bar grew.
 */
export async function addMediaToPrompt(page, idOrTitle) {
  const media = await listMedia(page);
  const m = media.find(x => x.id === idOrTitle) || media.find(x => x.title === idOrTitle)
    || await findTile(page, { id: idOrTitle, title: idOrTitle });
  if (!m) return false;
  const count = () => page.locator('.prompt-ingredient-bar button[aria-label="Ingredient"]').count().catch(() => 0);
  const before = await count();
  const tile = page.locator(TILE).nth(m.index);
  const item = await openTileMenuItem(page, tile, /Add to prompt/);
  if (!item) {
    await page.keyboard.press('Escape');
    return false;
  }
  await item.click({ timeout: 5000 }).catch(() => item.evaluate(el => el.click(), undefined, { timeout: 3000 }));
  await page.waitForTimeout(800);
  return (await count()) > before;
}

/**
 * Set a still as the video start frame: tile menu → "Animate". Flow switches the
 * prompt bar to Video → Frames with the image in the start slot.
 */
/**
 * Read the composer's Start-frame slot (Frames mode). The slot is the element
 * just before the "swap_horiz" button; when filled it holds an <img>.
 * Returns { found, hasImg, mediaId, src, html } — html is a short snippet for logs.
 */
export async function readStartSlot(page) {
  return page.evaluate(() => {
    const swap = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === 'swap_horiz');
    if (!swap) return { found: false };
    let slot = swap.previousElementSibling;
    if (!slot) {
      const kids = [...swap.parentElement.children];
      slot = kids[kids.indexOf(swap) - 1] || null;
    }
    if (!slot) return { found: false };
    const img = slot.querySelector('img');
    const idEl = slot.querySelector('[data-media-id]') || (slot.hasAttribute?.('data-media-id') ? slot : null);
    const src = img ? (img.currentSrc || img.src || '') : '';
    return {
      found: true,
      hasImg: !!img,
      mediaId: idEl ? idEl.getAttribute('data-media-id') : null,
      src,
      text: (slot.innerText || '').trim().slice(0, 40),
      html: slot.outerHTML.replace(/\s+/g, ' ').slice(0, 600),
    };
  }).catch(() => ({ found: false }));
}

const stripQuery = u => (u || '').split('?')[0];

/** Does the Start slot show the tile we animated? null = can't tell. */
export function startSlotMatches(slot, tile) {
  if (!slot?.found || !slot.hasImg) return null;
  const tid = (tile.id || '').replace(/^(vid:|thumb:)/, '');
  if (slot.mediaId && tid && slot.mediaId === tid) return true;
  if (tid && /^[0-9a-f-]{36}$/i.test(tid) && slot.src.includes(tid)) return true;
  if (tile.src && stripQuery(slot.src) && stripQuery(slot.src) === stripQuery(tile.src)) return true;
  if (slot.mediaId && tid && slot.mediaId !== tid) return false;
  // Both are images with different addresses and no shared id.
  return slot.src && tile.src ? false : null;
}

/** Try to empty the Start slot (its close/remove button), so Animate starts clean. */
export async function clearStartSlot(page) {
  const slot = await readStartSlot(page);
  if (!slot.found || !slot.hasImg) return false;
  return page.evaluate(() => {
    const swap = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === 'swap_horiz');
    const s = swap?.previousElementSibling;
    if (!s) return false;
    const btn = [...s.querySelectorAll('button')].find(b => /close|cancel|delete|remove/i.test((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')));
    if (!btn) return false;
    btn.click();
    return true;
  }).catch(() => false);
}

export async function animateFromTile(page, { id, title }) {
  // The context menu sometimes fails to open (the virtual grid re-renders under
  // the cursor, or a leftover overlay eats the click). Retry a few times.
  let item = null;
  let m = null;
  for (let attempt = 1; attempt <= 4 && !item; attempt++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.mouse.move(8, 8).catch(() => {});
    await page.waitForTimeout(400 * attempt);
    m = await findTile(page, { id, title });
    if (!m) throw new FlowError(ErrorCodes.FLOW_PAGE_NOT_FOUND, `Start-frame image not found: ${id || title}`);
    const tile = page.locator(TILE).nth(m.index);
    const cand = await openTileMenuItem(page, tile, /Animate/, { tries: 1, timeoutMs: 4000 });
    if (cand) item = cand;
    else logger.warn('Animate item not shown; retrying', { attempt, id: id || title });
  }
  if (!item) {
    await page.keyboard.press('Escape').catch(() => {});
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Tile menu has no "Animate" item.');
  }
  await item.click({ timeout: 5000 }).catch(() => item.evaluate(el => el.click(), undefined, { timeout: 3000 }));
  await page.waitForTimeout(1500);
  const chip = await page.locator('button[aria-label="Settings trigger"]').first().textContent().catch(() => '');
  if (!/Video/.test(chip || '')) throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `Animate did not switch to Video mode (chip: "${chip}").`);
  return m;
}

/**
 * Animate a tile, then make sure the Start slot really holds that tile.
 * Nov 2026: three clips started from an OLD start frame although Animate was
 * clicked on the right tile. If the slot shows something else, clear it and
 * Animate again; after 3 tries throw (before Generate, so no credits are spent).
 */
export async function animateFromTileVerified(page, target, { tries = 3 } = {}) {
  let last = null;
  for (let t = 1; t <= tries; t++) {
    const before = await readStartSlot(page);
    if (before.hasImg) {
      const cleared = await clearStartSlot(page);
      logger.info('Start slot had an image before Animate', { cleared, mediaId: before.mediaId, src: (before.src || '').slice(0, 120) });
      await page.waitForTimeout(600);
    }
    const m = await animateFromTile(page, target);
    await page.waitForTimeout(800);
    const slot = await readStartSlot(page);
    const ok = startSlotMatches(slot, m);
    last = { tile: { id: m.id, title: m.title, src: (m.src || '').slice(0, 160) }, slot: { ...slot, src: (slot.src || '').slice(0, 160) }, ok };
    logger.info('Start slot check', { try: t, ok, tileId: m.id, slotMediaId: slot.mediaId, slotSrc: (slot.src || '').slice(0, 120), tileSrc: (m.src || '').slice(0, 120) });
    if (ok === true) return { ...m, start_slot_check: 'match' };
    if (ok === null) {
      logger.warn('Start slot could not be verified', { slotHtml: slot.html });
      return { ...m, start_slot_check: 'unverified', start_slot_html: slot.html };
    }
    logger.warn('Start slot shows a different image; retrying Animate', { try: t });
    await page.keyboard.press('Escape').catch(() => {});
  }
  throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `Start frame did not take: the Start slot still shows a different image after ${tries} tries.`, last);
}

/**
 * Upload a local image into the current project. Tries the header "Add media
 * menu" → Upload, then the prompt "+" / "@" picker's "Upload media" button,
 * catching the native file chooser. Waits for the new tile and returns it.
 */
export async function uploadMedia(page, filePath) {
  if (!fs.existsSync(filePath)) throw new FlowError(ErrorCodes.INVALID_PARAMS, `File not found: ${filePath}`);
  await scrollGridToTop(page);
  const before = await listMedia(page);

  const tryRoute = async (openFn) => {
    const chooserP = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
    const opened = await openFn().catch(() => false);
    if (!opened) return false;
    const chooser = await chooserP;
    if (!chooser) { await page.keyboard.press('Escape').catch(() => {}); return false; }
    await chooser.setFiles(filePath);
    return true;
  };

  const viaHeader = async () => {
    const btn = page.locator('button[aria-label="Add media menu"]').first();
    if (!(await btn.isVisible({ timeout: 3000 }).catch(() => false))) return false;
    await btn.click();
    const item = page.locator(MENU_ITEM).filter({ hasText: /Upload/i }).first();
    if (!(await item.isVisible({ timeout: 3000 }).catch(() => false))) { await page.keyboard.press('Escape'); return false; }
    await item.click();
    return true;
  };
  const viaPicker = async () => {
    const btn = page.locator('button[aria-label="Add ingredients to the prompt box"]').first();
    if (!(await btn.isVisible({ timeout: 3000 }).catch(() => false))) return false;
    await btn.click();
    const up = page.locator('.cdk-overlay-container button').filter({ hasText: /Upload/i }).first();
    if (!(await up.isVisible({ timeout: 3000 }).catch(() => false))) { await page.keyboard.press('Escape'); return false; }
    await up.click();
    return true;
  };

  let ok = await tryRoute(viaHeader);
  if (!ok) ok = await tryRoute(viaPicker);
  if (!ok) {
    // Last resort: a file input already in the DOM.
    const input = page.locator('input[type="file"]').first();
    if (await input.count()) { await input.setInputFiles(filePath); ok = true; }
  }
  if (!ok) {
    await takeScreenshot(page, 'upload-no-route');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not find an upload control in this project.');
  }
  logger.info('Upload started', { file: path.basename(filePath) });
  await page.waitForTimeout(1500);
  // Flow asks the user to confirm rights to the image. That is the user's
  // call, so wait (up to 5 min) for them to answer it in the browser.
  const rights = page.getByText('Rights to use this image').first();
  if (await rights.isVisible({ timeout: 1500 }).catch(() => false)) {
    logger.warn('Waiting for the user to answer the "Rights to use this image" dialog');
    await rights.waitFor({ state: 'hidden', timeout: 300000 }).catch(() => {
      throw new FlowError(ErrorCodes.TIMEOUT || ErrorCodes.UNKNOWN_UI_CHANGE, 'The "Rights to use this image" dialog was not answered within 5 minutes.');
    });
  }
  const [tile] = await waitForNewMedia(page, before, { count: 1, timeoutMs: 120000 });
  return tile;
}
