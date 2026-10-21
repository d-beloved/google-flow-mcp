import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import fs from 'fs';
import path from 'path';
import { getFlowHome } from '../utils/config.js';
import { ensureProjectInContext, extractProjectId, buildProjectUrl, navigateToSidebar } from '../navigation/project-navigator.js';

const SELECTORS_PATH = path.join(getFlowHome(), 'config', 'selectors.map.json');

function loadSelectors() {
  try {
    return JSON.parse(fs.readFileSync(SELECTORS_PATH, 'utf-8'));
  } catch {
    return {
      _description: 'UI selectors map for Google Flow',
      _lastUpdated: null,
      main: { url: null, selectors: {} },
      imageGeneration: { selectors: {} },
      videoGeneration: { selectors: {} },
      characters: { url: null, selectors: {} },
      scenes: { url: null, selectors: {} },
      toolsGallery: { url: null, selectors: {} },
      gridArchitect: { url: null, selectors: {} },
    };
  }
}

function saveSelectors(map) {
  map._lastUpdated = new Date().toISOString();
  fs.writeFileSync(SELECTORS_PATH, JSON.stringify(map, null, 2));
  logger.info('Selectors map saved');
}

// flow.google.com (2026-10-21): project sub-routes are /character, /tools,
// /trash; Images/Scenes/All media are sidebar filters on the project page.
const PROJECT_SUBROUTE_PAGES = { characters: 'character', toolsGallery: 'tools', trash: 'trash' };

const PROJECT_TAB_PAGES = {
  scenes: 'Scenes',
  images: 'Images',
  'all-media': 'All media',
  imageGeneration: 'All media',
  videoGeneration: 'All media',
};

const PAGES = {
  main: 'https://flow.google.com/',
};

const PAGE_SELECTOR_KEYS = {
  main: 'main',
  characters: 'characters',
  scenes: 'scenes',
  'tools-gallery': 'toolsGallery',
  tools: 'toolsGallery',
  trash: 'trash',
  bin: 'trash',
  'tools gallery': 'toolsGallery',
  grid: 'gridArchitect',
  'grid-architect': 'gridArchitect',
  image: 'imageGeneration',
  video: 'videoGeneration',
};

function getPageKey(pageName) {
  const lower = (pageName || '').toLowerCase().trim();
  return PAGE_SELECTOR_KEYS[lower] || lower;
}

export async function handleDiscoverUi(args) {
  let page = getPage();
  const pageName = args.page || 'main';
  const pageKey = getPageKey(pageName);

  let url = args.url;
  let tabToClick = null;

  if (!url) {
    if (pageKey === 'gridArchitect') {
      const { openToolByName } = await import('../navigation/tools.js');
      await openToolByName(page, 'Grid Architect', { name: args.project_name, campaign: args.campaign, tab: 'Templates' });
      url = page.url();
    } else if (PROJECT_SUBROUTE_PAGES[pageKey]) {
      const project = await ensureProjectInContext(page, {
        name: args.project_name,
        campaign: args.campaign,
      });
      const projectId = extractProjectId(project.url);
      url = projectId
        ? `${buildProjectUrl(null, projectId)}/${PROJECT_SUBROUTE_PAGES[pageKey]}`
        : project.url;
    } else if (PROJECT_TAB_PAGES[pageKey]) {
      const project = await ensureProjectInContext(page, {
        name: args.project_name,
        campaign: args.campaign,
      });
      url = project.url;
      tabToClick = PROJECT_TAB_PAGES[pageKey];
    } else {
      url = PAGES[pageKey] || PAGES.main;
    }
  }

  logger.info('Discovering UI', { page: pageName, pageKey, url: url?.substring(0, 80), tabToClick });

  try {
    // Navigate to the page
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);

    // For sidebar-tab pages (Scenes/Images/All Media), click the tab —
    // these don't have their own URL, just a client-side state change.
    if (tabToClick) {
      await navigateToSidebar(page, tabToClick);
      await page.waitForTimeout(1500);
    }

    const currentUrl = page.url();
    const title = await page.title();

    // Take full page screenshot
    const screenshotPath = await takeScreenshot(page, `discover-${pageName}`);

    // Extract visible text content
    const visibleText = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      const texts = [];
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent?.trim();
        if (text && text.length > 2 && text.length < 200) {
          texts.push(text);
        }
      }
      return [...new Set(texts)].slice(0, 200);
    });

    // Detect all interactive elements
    const elements = await detectPageElements();

    // Extract specifically model-related text
    const modelNames = visibleText.filter(t =>
      t.includes('Nano') || t.includes('Imagen') || t.includes('Veo') || t.includes('Omni') ||
      t.includes('Model')
    );

    // Extract ratio-related text
    const ratioTexts = visibleText.filter(t =>
      t.includes(':') && (t.includes('9') || t.includes('4') || t.includes('3') || t.includes('1'))
    );

    // Update selectors map
    const selectorsMap = loadSelectors();
    selectorsMap[pageKey] = {
      url: currentUrl,
      title,
      discoveredAt: new Date().toISOString(),
      selectors: {
        buttons: elements.buttons,
        inputs: elements.inputs,
        links: elements.links,
        headings: elements.headings,
        modelTexts: modelNames,
        ratioTexts: ratioTexts,
      },
    };
    saveSelectors(selectorsMap);

    return {
      status: 'discovered',
      page: pageName,
      pageKey,
      url: currentUrl,
      title,
      screenshot: screenshotPath,
      elements: {
        buttons: elements.buttons.map(b => b.text).filter(Boolean),
        inputs: elements.inputs.map(i => i.placeholder || i.ariaLabel || i.name).filter(Boolean),
        headings: elements.headings.map(h => `${h.level}: ${h.text}`),
        visible_models: modelNames,
        visible_ratios: ratioTexts,
      },
      totalButtonsFound: elements.buttons.length,
      totalInputsFound: elements.inputs.length,
    };
  } catch (err) {
    await takeScreenshot(page, `discover-error-${pageName}`);
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      `UI discovery failed for ${pageName}: ${err.message}`
    );
  }
}
