// Flow Tools (verified 2026-10-21): gallery at /project/{id}/tools with tabs
// (button[role=radio]) "My tools" | "Community" | "Templates". Each card has a
// .applet-title-row ("<Tool name>\n<Author>"). Clicking a card opens
// /project/{id}/tool/{uuid}?mode=APP; the tool UI runs in a sandboxed iframe
// on *.usercontent.goog.

import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { ensureProjectInContext, navigateToSidebar } from './project-navigator.js';

export const TOOL_TABS = ['My tools', 'Templates', 'Community'];
const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function selectTab(page, tab) {
  const btn = page.locator('button[role="radio"]').filter({ hasText: new RegExp(`^\\s*${tab}\\s*$`) }).first();
  if (!(await btn.isVisible({ timeout: 8000 }).catch(() => false))) return false;
  if ((await btn.getAttribute('aria-checked')) !== 'true') await btn.click();
  await page.locator('.applet-title-row').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  return true;
}

async function readTitles(page) {
  return page.evaluate(() => [...document.querySelectorAll('.applet-title-row')].map(r => {
    const lines = r.innerText.split('\n').map(s => s.trim()).filter(s => s && s !== 'more_vert');
    return { name: lines[0] || '', author: lines.slice(1).join(' ') };
  }));
}

/** List tools in the gallery: { "My tools": [...], "Templates": [...], "Community": [...] } */
export async function listTools(page, context = {}) {
  await ensureProjectInContext(page, context);
  await navigateToSidebar(page, 'Tools');
  const out = {};
  for (const tab of TOOL_TABS) {
    if (await selectTab(page, tab)) out[tab] = await readTitles(page);
  }
  return out;
}

/** Open a tool by its card title. Exact name match first, then unique prefix. */
export async function openToolByName(page, toolName, context = {}) {
  await ensureProjectInContext(page, context);
  await navigateToSidebar(page, 'Tools');
  const target = norm(toolName);
  const seen = [];
  for (const tab of (context.tab ? [context.tab] : TOOL_TABS)) {
    if (!(await selectTab(page, tab))) continue;
    const titles = await readTitles(page);
    seen.push(...titles.map(t => `${t.name} (${tab})`));
    let idx = titles.findIndex(t => norm(t.name) === target);
    if (idx < 0) {
      const pref = titles.map((t, i) => [t, i]).filter(([t]) => norm(t.name).startsWith(target));
      if (pref.length === 1) idx = pref[0][1];
    }
    if (idx < 0) continue;
    await page.locator('.applet-title-row').nth(idx).click();
    await page.waitForURL(u => /\/tool\//.test(u.pathname), { timeout: 15000 }).catch(() => {});
    const frame = await waitForToolFrame(page);
    logger.info('Opened tool', { tool: titles[idx].name, tab, url: page.url(), frame: !!frame });
    return { name: titles[idx].name, tab, url: page.url(), frame };
  }
  await takeScreenshot(page, 'tool-not-found');
  throw new FlowError(ErrorCodes.FLOW_PAGE_NOT_FOUND,
    `Tool "${toolName}" not found. Available: ${seen.slice(0, 40).join(', ')}`);
}

export async function waitForToolFrame(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = page.frames().find(f => /usercontent\.goog/.test(f.url()) && !/shim\.htm/.test(f.url()))
      || page.frames().find(f => /usercontent\.goog/.test(f.url()));
    if (frame) {
      await frame.waitForLoadState('load').catch(() => {});
      return frame;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/**
 * Best-effort: fill tool inputs by accessible label / placeholder / name,
 * searching every tool frame. Returns { filled: [...], missing: [...] }.
 */
export async function fillToolParams(page, params = {}) {
  const frames = page.frames().filter(f => /usercontent\.goog/.test(f.url()));
  const filled = [];
  const missing = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    let done = false;
    for (const f of frames) {
      const candidates = [
        f.getByLabel(key, { exact: false }),
        f.getByPlaceholder(key, { exact: false }),
        f.locator(`[name="${key}"]`),
      ];
      for (const c of candidates) {
        const el = c.first();
        if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) continue;
        const tag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => '');
        if (tag === 'select') await el.selectOption({ label: String(value) }).catch(() => el.selectOption(String(value)));
        else await el.fill(String(value));
        done = true;
        break;
      }
      if (done) break;
    }
    (done ? filled : missing).push(key);
  }
  return { filled, missing };
}
