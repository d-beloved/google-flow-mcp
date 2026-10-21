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
    return {
      id: idEl?.getAttribute('data-media-id') || (src ? `thumb:${src}` : `tile:${index}:${tile.getAttribute('aria-label') || ''}`),
      type: isVideo ? 'video' : 'image',
      title: tile.getAttribute('aria-label') || '',
      src,
      ready,
      index,
    };
  }).filter((m, i, a) => a.findIndex(x => x.id === m.id) === i), TILE);
}

async function tileLocator(page, mediaId) {
  const media = await listMedia(page);
  const m = media.find(x => x.id === mediaId);
  return m ? { loc: page.locator(TILE).nth(m.index), media: m } : null;
}

/**
 * Wait until `count` new, loaded tiles appear. Flow inserts new results at the
 * top of the grid, so the new tiles are the first (now - before) tiles. This is
 * count-based on purpose: thumbnail URLs are signed and can change on re-render,
 * so comparing keys alone can mistake an old tile for a new one.
 * `before` is the listMedia() array (or ids) captured before clicking Generate.
 */
export async function waitForNewMedia(page, before, { count = 1, timeoutMs = 180000, type } = {}) {
  const beforeCount = Array.isArray(before) ? before.length : 0;
  const beforeKeys = new Set((before || []).map(b => (typeof b === 'string' ? b : b.id)));
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < timeoutMs) {
    const media = await listMedia(page).catch(() => []);
    const added = Math.max(0, media.length - beforeCount);
    const fresh = media.slice(0, added)
      .filter(m => !type || m.type === type)
      .filter(m => !beforeKeys.has(m.id) || m.id.startsWith('thumb:'));
    const ready = fresh.filter(m => m.ready);
    if (ready.length >= count) {
      return ready.slice(0, count);
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
      logger.info('Waiting for new media', {
        elapsedS: Math.round((Date.now() - start) / 1000), tilesBefore: beforeCount, tilesNow: media.length, ready: ready.length,
      });
    }
    await page.waitForTimeout(1500);
  }
  const media = await listMedia(page).catch(() => []);
  const partial = media.slice(0, Math.max(0, media.length - beforeCount)).filter(m => m.ready && (!type || m.type === type));
  if (partial.length) return partial;
  await takeScreenshot(page, 'generation-timeout');
  throw new FlowError(ErrorCodes.GENERATION_TIMEOUT,
    `No new media appeared within ${Math.round(timeoutMs / 1000)}s. Check the Flow project.`);
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
    await page.keyboard.press('Escape').catch(() => {});
    await tile.scrollIntoViewIfNeeded().catch(() => {});
    await tile.click({ button: 'right' });

    const dl = page.locator(MENU_ITEM).filter({ hasText: /Download$/ }).first();
    if (!(await dl.isVisible({ timeout: 5000 }).catch(() => false))) {
      await takeScreenshot(page, 'download-menu-missing');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Tile menu has no "Download" item.');
    }
    await dl.click();
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
      if (pwDownload) {
        const name = pwDownload.suggestedFilename() || `${mediaId}.${type === 'video' ? 'mp4' : 'png'}`;
        const file = path.join(outDir, name);
        await pwDownload.saveAs(file);
        return { path: file, filename: name, size: optLabels[idx], mediaId };
      }
    }
    await takeScreenshot(page, 'download-timeout');
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
      `Download did not finish within ${Math.round(timeoutMs / 1000)}s. Last Flow message: ${await snackbarText(page)}`);
  } finally {
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
  const m = media.find(x => x.id === idOrTitle) || media.find(x => x.title === idOrTitle);
  if (!m) return false;
  const count = () => page.locator('.prompt-ingredient-bar button[aria-label="Ingredient"]').count().catch(() => 0);
  const before = await count();
  const tile = page.locator(TILE).nth(m.index);
  await tile.scrollIntoViewIfNeeded().catch(() => {});
  await tile.click({ button: 'right' });
  const item = page.locator(MENU_ITEM).filter({ hasText: /Add to prompt$/ }).first();
  if (!(await item.isVisible({ timeout: 4000 }).catch(() => false))) {
    await page.keyboard.press('Escape');
    return false;
  }
  await item.click();
  await page.waitForTimeout(800);
  return (await count()) > before;
}
