// Project navigation for Google Flow (flow.google.com), verified 2026-10-21.
//
// Home page (https://flow.google.com/):
//   .project-card
//     a.project-thumbnail-container[href="/project/{id}"]   ("Open project")
//     .project-title-label                                    (project name text)
//     button[aria-label="Edit project title"], button[aria-label="Delete project"]
//   button.new  ("New project" FAB)
//   All projects render at once (no search box, no lazy loading).
//
// Project page (https://flow.google.com/project/{id}):
//   input.editable-text-input[aria-label="Editable text"]  (project title, top left)
//   Sidebar: All media | Images | Characters | Scenes (filters), Library, Tools, Bin
//   Characters creation page: /project/{id}/character
//   Tools gallery:            /project/{id}/tools
//   Bin:                      /project/{id}/trash

import { logger } from '../utils/logger.js';
import { get, getFlowHome } from '../utils/config.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements, configureGenerationUI } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import fs from 'fs';
import path from 'path';

export const FLOW_BASE = 'https://flow.google.com';
const PROJECTS_FILE = path.join(getFlowHome(), 'config', 'flow.projects.json');

let _sessionProjectId = null;

export function extractProjectId(url) {
  const m = (url || '').match(/\/project\/([^/?#]+)/);
  return m ? m[1] : null;
}

// baseUrl is ignored (kept for old call sites); Flow lives on flow.google.com.
export function buildProjectUrl(_baseUrl, projectId) {
  return `${FLOW_BASE}/project/${projectId}`;
}

function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
  } catch (e) {
    logger.warn('Could not load projects file', { error: e.message });
  }
  return { projects: [] };
}

function saveProjects(data) {
  const dir = path.dirname(PROJECTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2));
}

function remember(entry) {
  const store = loadProjects();
  const existing = store.projects.find(p => extractProjectId(p.url) === entry.id);
  const now = new Date().toISOString();
  if (existing) {
    Object.assign(existing, { name: entry.name ?? existing.name, last_used: now });
    if (entry.campaign) existing.campaign = entry.campaign;
  } else {
    store.projects.push({
      id: entry.id, url: buildProjectUrl(null, entry.id), name: entry.name,
      campaign: entry.campaign, created_at: now, last_used: now, tasks: [],
    });
  }
  saveProjects(store);
}

const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function goHome(page) {
  const u = new URL(page.url() || 'about:blank', FLOW_BASE);
  if (!(u.host === 'flow.google.com' && (u.pathname === '/' || u.pathname === ''))) {
    await page.goto(`${FLOW_BASE}/`, { waitUntil: 'load', timeout: 30000 });
  }
  await page.locator('.project-card, button.new').first()
    .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  if (page.url().includes('accounts.google.com')) {
    throw new FlowError(ErrorCodes.NOT_LOGGED_IN,
      'Flow redirected to Google sign-in. Sign in to Flow in the automation Chrome, then retry.');
  }
}

/** List projects on the Flow home page → [{ id, name, url }] (newest first). */
export async function listExistingProjects(page) {
  await goHome(page);
  const projects = await page.evaluate(() => {
    const seen = new Set();
    return [...document.querySelectorAll('.project-card')].map(card => {
      const href = card.querySelector('a[href*="/project/"]')?.getAttribute('href') || '';
      const id = (href.match(/\/project\/([^/?#]+)/) || [])[1];
      const label = card.querySelector('.project-title-label');
      // Title is the label's own text, without the icon-button ligatures.
      const name = label
        ? [...label.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim()
        : '';
      return { id, name };
    }).filter(p => p.id && !seen.has(p.id) && seen.add(p.id));
  });
  logger.info('Projects on home page', { count: projects.length });
  return projects.map(p => ({ ...p, url: buildProjectUrl(null, p.id) }));
}

/**
 * Find a project by name. Exact (case-insensitive) match wins; otherwise a
 * unique "contains" match. Returns { match, candidates }.
 */
export async function findProjectByName(page, name) {
  const projects = await listExistingProjects(page);
  const target = norm(name);
  const exact = projects.filter(p => norm(p.name) === target);
  if (exact.length) return { match: exact[0], candidates: exact };
  const partial = projects.filter(p => norm(p.name).includes(target));
  return { match: partial.length === 1 ? partial[0] : null, candidates: partial };
}

async function waitForProjectPage(page) {
  await page.locator('[role="textbox"][aria-label="What do you want to create?"], input.editable-text-input')
    .first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
}

/** Open an existing project by name. Throws if none or several match. */
export async function openProjectByName(page, name) {
  const { match, candidates } = await findProjectByName(page, name);
  if (!match) {
    throw new FlowError(ErrorCodes.FLOW_PAGE_NOT_FOUND,
      candidates.length
        ? `Several projects match "${name}": ${candidates.map(c => `"${c.name}"`).join(', ')}. Use the exact name.`
        : `No project named "${name}" on the Flow home page.`,
      { candidates });
  }
  await page.goto(match.url, { waitUntil: 'load', timeout: 30000 });
  await waitForProjectPage(page);
  _sessionProjectId = match.id;
  remember({ id: match.id, name: match.name });
  logger.info('Opened project by name', { name: match.name, id: match.id });
  return { url: page.url(), projectId: match.id, name: match.name, reused: true };
}

export async function getCurrentProjectName(page) {
  return page.locator('input.editable-text-input').first().inputValue({ timeout: 3000 }).catch(() => null);
}

/** Rename the project currently open (title input, top left). */
export async function renameCurrentProject(page, newName) {
  if (!newName) return false;
  const input = page.locator('input.editable-text-input').first();
  if (!(await input.isVisible({ timeout: 5000 }).catch(() => false))) {
    await takeScreenshot(page, 'rename-project-no-title-input');
    logger.warn('Project title input not found');
    return false;
  }
  await input.click();
  await input.fill(newName);
  await input.press('Enter');
  await page.waitForTimeout(800);
  const now = await input.inputValue().catch(() => '');
  const ok = norm(now) === norm(newName);
  logger.info(ok ? 'Project renamed' : 'Project rename not confirmed', { newName, now });
  return ok;
}

/** Create a new project from the home page and optionally name it. */
export async function createNewProject(page, name, campaign) {
  await goHome(page);
  const before = page.url();
  const newBtn = page.locator('button.new, button:has-text("New project")').first();
  if (!(await newBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
    await takeScreenshot(page, 'no-new-project-btn');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, '"New project" button not found on the Flow home page.');
  }
  await newBtn.click();
  await page.waitForURL(u => u.pathname.includes('/project/'), { timeout: 15000 }).catch(() => {});
  const id = extractProjectId(page.url());
  if (!id) {
    await takeScreenshot(page, 'new-project-no-url');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `New project did not open (still on ${before}).`);
  }
  await waitForProjectPage(page);
  if (name) await renameCurrentProject(page, name);
  const finalName = (await getCurrentProjectName(page)) || name || null;
  _sessionProjectId = id;
  remember({ id, name: finalName, campaign });
  logger.info('New project created', { id, name: finalName });
  return { url: page.url(), projectId: id, name: finalName, reused: false };
}

/**
 * Make sure a project is open. Never renames an existing project.
 *   context.project_id → open that project
 *   context.name       → reuse the open project if its title matches; else open
 *                        the existing project with that name; else create one.
 *   context.campaign   → reuse the project last used for that campaign
 *   context.forceNew   → always create a new project
 *   nothing            → reuse the open/session project, else create one
 */
export async function ensureProjectInContext(page, context = {}) {
  const { name, campaign, forceNew, project_id: projectId } = context;
  const currentId = extractProjectId(page.url());

  if (forceNew) return createNewProject(page, name, campaign);

  if (projectId) {
    if (currentId !== projectId) {
      await page.goto(buildProjectUrl(null, projectId), { waitUntil: 'load', timeout: 30000 });
      await waitForProjectPage(page);
    }
    _sessionProjectId = projectId;
    return { url: page.url(), projectId, name: await getCurrentProjectName(page), reused: true };
  }

  if (name) {
    if (currentId && norm(await getCurrentProjectName(page)) === norm(name)) {
      _sessionProjectId = currentId;
      return { url: page.url(), projectId: currentId, name, reused: true };
    }
    const { match } = await findProjectByName(page, name);
    if (match && norm(match.name) === norm(name)) {
      await page.goto(match.url, { waitUntil: 'load', timeout: 30000 });
      await waitForProjectPage(page);
      _sessionProjectId = match.id;
      remember({ id: match.id, name: match.name, campaign });
      return { url: page.url(), projectId: match.id, name: match.name, reused: true };
    }
    return createNewProject(page, name, campaign);
  }

  if (campaign) {
    const hit = loadProjects().projects
      .filter(p => p.campaign && norm(p.campaign) === norm(campaign))
      .sort((a, b) => (b.last_used || '').localeCompare(a.last_used || ''))[0];
    if (hit) {
      const id = extractProjectId(hit.url);
      await page.goto(buildProjectUrl(null, id), { waitUntil: 'load', timeout: 30000 });
      await waitForProjectPage(page);
      if (extractProjectId(page.url()) === id) {
        _sessionProjectId = id;
        remember({ id, campaign });
        return { url: page.url(), projectId: id, name: hit.name, reused: true };
      }
    }
  }

  if (currentId) {
    _sessionProjectId = currentId;
    return { url: page.url(), projectId: currentId, name: await getCurrentProjectName(page), reused: true };
  }

  if (_sessionProjectId) {
    await page.goto(buildProjectUrl(null, _sessionProjectId), { waitUntil: 'load', timeout: 30000 });
    await waitForProjectPage(page);
    if (extractProjectId(page.url()) === _sessionProjectId) {
      return { url: page.url(), projectId: _sessionProjectId, name: await getCurrentProjectName(page), reused: true };
    }
    _sessionProjectId = null;
  }

  return createNewProject(page, null, campaign);
}

/**
 * Open a project section. "Characters" → /character (create page),
 * "Tools" → /tools, "Trash"/"Bin" → /trash; "Images", "Scenes", "All media"
 * are sidebar filters on the project page.
 */
export async function navigateToSidebar(page, section) {
  const id = extractProjectId(page.url()) || _sessionProjectId;
  if (!id) {
    logger.warn('navigateToSidebar: no project open');
    return false;
  }
  const base = buildProjectUrl(null, id);
  const routes = { characters: '/character', character: '/character', tools: '/tools', trash: '/trash', bin: '/trash' };
  const route = routes[norm(section)];
  if (route) {
    await page.goto(base + route, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(1500);
    return true;
  }
  if (extractProjectId(page.url()) !== id || /\/(character|tools|trash|tool)\b/.test(new URL(page.url()).pathname.split(id)[1] || '')) {
    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await waitForProjectPage(page);
  }
  const filter = page.locator('button.mat-mdc-list-item')
    .filter({ hasText: new RegExp(`${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).first();
  if (await filter.isVisible({ timeout: 5000 }).catch(() => false)) {
    await filter.click();
    await page.waitForTimeout(1000);
    return true;
  }
  const elements = await detectPageElements(page);
  await takeScreenshot(page, `sidebar-${section}-not-found`);
  logger.warn('Sidebar section not found', { section, buttons: elements.buttons.map(b => b.text).filter(Boolean) });
  return false;
}

export async function getActiveSidebarSection(page) {
  return page.evaluate(() => {
    const a = document.querySelector('button.mat-mdc-list-item.active, button.mat-mdc-list-item[aria-current], .mdc-list-item--activated');
    return a ? a.textContent.replace(/\s+/g, ' ').trim() : null;
  }).catch(() => null);
}

export function registerTaskInProject(projectId, taskInfo) {
  if (!projectId) return;
  const store = loadProjects();
  const proj = store.projects.find(p => p.id === projectId || extractProjectId(p.url) === projectId);
  if (proj) {
    proj.tasks = proj.tasks || [];
    proj.tasks.push({ ...taskInfo, timestamp: new Date().toISOString() });
    proj.last_used = new Date().toISOString();
    saveProjects(store);
  }
}

export async function getProjectContextInfo(page) {
  const url = page.url();
  const projectId = extractProjectId(url);
  return {
    inProject: !!projectId,
    url,
    projectId,
    projectName: projectId ? await getCurrentProjectName(page) : null,
    activeSection: projectId ? await getActiveSidebarSection(page) : null,
  };
}

/** Switch the prompt toolbar to Image mode (settings chip → Image toggle). */
export async function switchToImageMode(_page) {
  await configureGenerationUI({ mode: 'Image' });
  return true;
}
