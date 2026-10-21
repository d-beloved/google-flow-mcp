import { get } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { getPage } from './connect.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

const ACTION_DELAY = get('actionDelayMs', 800);

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Checks the page for reCAPTCHA or Unusual Traffic notices and pauses execution
 * until resolved by manual user interaction.
 */
export async function checkForCaptcha(page) {
  if (!page) {
    page = getPage();
  }
  if (!page) return;

  const isSorryPage = page.url().includes('google.com/sorry');
  const hasCaptcha = await page.evaluate(() => {
    if (document.querySelector('iframe[src*="recaptcha"]')) return true;
    if (document.querySelector('#recaptcha')) return true;
    if (document.querySelector('.g-recaptcha')) return true;
    const pageText = document.body ? document.body.innerText : '';
    if (pageText.includes('unusual traffic') || pageText.includes('detected unusual traffic')) return true;
    return false;
  }).catch(() => false);

  if (isSorryPage || hasCaptcha) {
    logger.warn('CAPTCHA or bot detection page detected! Pausing execution.');
    console.log('\n======================================================');
    console.log('⚠️  CAPTCHA OR BOT DETECTION DETECTED!');
    console.log('Please check the browser window and solve the CAPTCHA manually.');
    console.log('The script will resume automatically once solved.');
    console.log('======================================================\n');

    let attempts = 0;
    const maxAttempts = 60; // 5 minutes
    while (attempts < maxAttempts) {
      await delay(5000);
      const stillSorry = page.url().includes('google.com/sorry');
      const stillHasCaptcha = await page.evaluate(() => {
        if (document.querySelector('iframe[src*="recaptcha"]')) return true;
        if (document.querySelector('#recaptcha')) return true;
        if (document.querySelector('.g-recaptcha')) return true;
        const pageText = document.body ? document.body.innerText : '';
        if (pageText.includes('unusual traffic') || pageText.includes('detected unusual traffic')) return true;
        return false;
      }).catch(() => false);

      if (!stillSorry && !stillHasCaptcha) {
        logger.info('CAPTCHA solved or cleared! Resuming execution.');
        return;
      }
      attempts++;
      if (attempts % 6 === 0) {
        logger.warn(`Still waiting for CAPTCHA to be solved (${attempts * 5} seconds passed)...`);
      }
    }
    throw new Error('CAPTCHA was not solved within 5 minutes. Aborting operation.');
  }
}

/**
 * Types text characters one by one with randomized delays to mimic human typing.
 * @param {any} elementOrKeyboard - Playwright locator, element handle, or page.keyboard
 * @param {string} text
 */
// Text at or under this length is typed key by key (names, "@", search terms),
// so popups that listen for key events still fire. Longer text is pasted.
const TYPE_MAX_CHARS = get('typeMaxChars', 30);

/**
 * Enter text into the focused element (Keyboard) or a Locator.
 * Short text: typed with human-like delays. Long text (prompts): inserted in
 * one go via keyboard.insertText — a single input event, like a paste.
 */
export async function typeLikeHuman(elementOrKeyboard, text) {
  const isKeyboard = typeof elementOrKeyboard.insertText === 'function';

  if (text.length > TYPE_MAX_CHARS) {
    if (isKeyboard) {
      await elementOrKeyboard.insertText(text);
    } else {
      await elementOrKeyboard.focus();
      await elementOrKeyboard.page().keyboard.insertText(text);
    }
    await delay(150);
    return;
  }

  for (const char of text) {
    const delayMs = Math.floor(Math.random() * (120 - 40 + 1)) + 40;
    await elementOrKeyboard.type(char);
    await delay(delayMs);
  }
}

/**
 * Safe click with pre- and post-delay
 */
export async function safeClick(selector, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 10000;
  const preDelay = options.preDelay || ACTION_DELAY;
  const postDelay = options.postDelay || ACTION_DELAY;

  await checkForCaptcha(page);
  await delay(preDelay);
  const element = await page.waitForSelector(selector, { timeout, state: 'visible' });
  if (!element) {
    throw new Error(`Element not found: ${selector}`);
  }
  await element.click();
  await delay(postDelay);
  logger.debug('Clicked element', { selector });
}

/**
 * Safe fill input
 */
export async function safeFill(selector, text, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 10000;
  const preDelay = options.preDelay || ACTION_DELAY;
  const postDelay = options.postDelay || ACTION_DELAY;

  await checkForCaptcha(page);
  await delay(preDelay);
  const element = await page.waitForSelector(selector, { timeout, state: 'visible' });
  if (!element) {
    throw new Error(`Input not found: ${selector}`);
  }
  await element.click();
  await element.fill('');
  await delay(200);
  await typeLikeHuman(element, text);
  await delay(postDelay);
  logger.debug('Filled input', { selector, textLength: text.length });
}

/**
 * Safe press keyboard key
 */
export async function safePress(key, options = {}) {
  const page = getPage();
  const preDelay = options.preDelay || ACTION_DELAY;
  await checkForCaptcha(page);
  await delay(preDelay);
  await page.keyboard.press(key);
  await delay(ACTION_DELAY);
}

/**
 * Wait for text to appear on page
 */
export async function waitForText(text, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 15000;
  try {
    await page.waitForSelector(`text=${text}`, { timeout });
    logger.debug('Text found on page', { text });
    return true;
  } catch {
    logger.warn('Text not found on page', { text });
    return false;
  }
}

/**
 * Navigate and wait for load
 */
export async function safeGoto(url, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 30000;
  const preDelay = options.preDelay || 500;

  await delay(preDelay);
  logger.info('Navigating', { url: url.substring(0, 80) });
  await page.goto(url, { waitUntil: 'load', timeout });
  await checkForCaptcha(page);
  await delay(ACTION_DELAY);
}

/**
 * Get visible text of all elements matching selector
 */
export async function getVisibleTexts(selector) {
  const page = getPage();
  const elements = await page.$$(selector);
  const texts = [];
  for (const el of elements) {
    if (await el.isVisible()) {
      const text = await el.textContent();
      if (text && text.trim()) texts.push(text.trim());
    }
  }
  return texts;
}

/**
 * Detect all buttons, inputs, and interactive elements on the page
 */
export async function detectPageElements() {
  const page = getPage();
  const elements = await page.evaluate(() => {
    const result = {
      buttons: [],
      inputs: [],
      links: [],
      dropdowns: [],
      headings: [],
      labels: [],
    };

    document.querySelectorAll('button, [role="button"], [type="button"]').forEach(el => {
      const text = el.textContent?.trim() || el.getAttribute('aria-label') || '';
      if (text && text.length < 100) {
        result.buttons.push({
          text: text.substring(0, 80),
          visible: !!el.offsetParent,
          tag: el.tagName,
          ariaLabel: el.getAttribute('aria-label') || null,
          dataTestId: el.getAttribute('data-test-id') || el.getAttribute('data-testid') || null,
        });
      }
    });

    document.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]').forEach(el => {
      const placeholder = el.getAttribute('placeholder') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const name = el.getAttribute('name') || '';
      result.inputs.push({
        placeholder: placeholder.substring(0, 60),
        ariaLabel: ariaLabel.substring(0, 60),
        name: name.substring(0, 60),
        type: el.getAttribute('type') || el.tagName,
        visible: !!el.offsetParent,
      });
    });

    document.querySelectorAll('a[href]').forEach(el => {
      const text = el.textContent?.trim() || '';
      if (text && text.length < 80) {
        result.links.push({
          text: text.substring(0, 60),
          href: (el.getAttribute('href') || '').substring(0, 100),
          visible: !!el.offsetParent,
        });
      }
    });

    document.querySelectorAll('select, [role="listbox"]').forEach(el => {
      const label = el.getAttribute('aria-label') || el.textContent?.trim() || '';
      result.dropdowns.push({
        label: label.substring(0, 60),
        visible: !!el.offsetParent,
      });
    });

    document.querySelectorAll('h1, h2, h3, h4').forEach(el => {
      result.headings.push({
        level: el.tagName,
        text: (el.textContent?.trim() || '').substring(0, 80),
      });
    });

    return result;
  });

  return elements;
}

/**
 * Read the current generation mode from the toolbar tabs.
 * Returns 'image', 'video', or null if not determinable.
 */
export async function readCurrentGenerationMode() {
  // Settings chip text: "🍌 Nano Banana 2.1 crop_16_9 x1" (image) or "Video · 720p · 6s crop_16_9 x1".
  const page = getPage();
  const chip = await page.locator('button[aria-label="Settings trigger"]').first()
    .textContent({ timeout: 5000 }).catch(() => null);
  if (!chip) return null;
  return /^\s*Video\b/.test(chip.trim()) ? 'Video' : 'Image';
}

/**
 * Safely configures the generation settings (mode, ratio, model, quantity, duration)
 * by clicking the correct tabs in the Flow bottom toolbar.
 *
 * The Flow toolbar has these layers:
 *   • Top-level mode tabs: Image | Video  (role=tab, id=*trigger-IMAGE / *trigger-VIDEO)
 *   • Settings panel (opened by clicking a settings/gear button or the model name chip)
 *     - Ratio tabs: 1:1 | 16:9 | 9:16 | 4:3 | 3:4
 *     - Quantity tabs: 1x | x2 | x3 | x4
 *     - Duration tabs (video only): 4s | 6s | 8s
 *     - Model dropdown (arrow_drop_down button)
 */
// ─────────────────────────────────────────────────────────────────────────────
// configureGenerationUI — written against the Flow UI on flow.google.com
// (verified 2026-10-21). The prompt toolbar has one chip,
// button[aria-label="Settings trigger"] (e.g. "🍌 Nano Banana 2.1 crop_16_9 x1").
// Clicking it opens a cdk overlay panel with:
//   • mat-button-toggle radios: Image | Video, ratios, x1..x4 (aria-checked)
//   • button[aria-label="Select model family"] → menu of [role=menuitem]
// Never click generic buttons: the header has "Settings" (app settings) and
// "More options for the project" menus that open overlays and block clicks.
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_TRIGGER = 'button[aria-label="Settings trigger"], button.settings-trigger-button';
const MODEL_TRIGGER = 'button[aria-label="Select model family"]';
const OVERLAY = '.cdk-overlay-container';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLabel(s) {
  return (s || '')
    // Icon ligatures; textContent can glue them to labels ("volume_upVeo 3.1 - Fast").
    .replace(/(arrow_drop_down|volume_up|chrome_extension|crop_(?:16_9|9_16|landscape|square|portrait|free))/g, ' ')
    .replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s.:-]/gu, '') // strip emoji / symbols
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function waitVisible(locator, timeout = 3000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function closeOverlays(page) {
  for (let i = 0; i < 4; i++) {
    const open = await page.locator('.cdk-overlay-backdrop-showing').count().catch(() => 0);
    if (!open) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
}

async function openSettingsPanel(page) {
  const panelRadio = page.locator(`${OVERLAY} button[role="radio"]`).first();
  if (await panelRadio.isVisible().catch(() => false)) return true;

  await closeOverlays(page);
  const trigger = page.locator(SETTINGS_TRIGGER).first();
  if (!(await waitVisible(trigger, 10000))) {
    await takeScreenshot(page, 'configure-ui-no-settings-trigger');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      'Settings chip (aria-label="Settings trigger") not found in the prompt toolbar.');
  }
  await trigger.click();
  return waitVisible(panelRadio, 5000);
}

async function pickToggle(page, label) {
  const btn = page.locator(`${OVERLAY} button[role="radio"]`)
    .filter({ hasText: new RegExp(`${escapeRe(label)}(\\s|$)`) }).first();
  if (!(await waitVisible(btn, 3000))) return false;
  if ((await btn.getAttribute('aria-checked')) !== 'true') {
    logger.info(`Selecting "${label}"`);
    await btn.click();
    await page.waitForFunction(
      el => el.getAttribute('aria-checked') === 'true',
      await btn.elementHandle(),
      { timeout: 3000 }
    ).catch(() => {});
  } else {
    logger.info(`"${label}" already selected`);
  }
  return (await btn.getAttribute('aria-checked')) === 'true';
}

async function pickModel(page, model) {
  const target = normalizeLabel(model);
  const modelBtn = page.locator(`${OVERLAY} ${MODEL_TRIGGER}`).first();
  if (!(await waitVisible(modelBtn, 3000))) return false;

  const current = normalizeLabel(await modelBtn.textContent().catch(() => ''));
  if (current === target) {
    logger.info(`Model "${model}" already selected`);
    return true;
  }

  logger.info(`Changing model from "${current}" to "${model}"`);
  await modelBtn.click();
  const items = page.locator(`${OVERLAY} [role="menuitem"]`);
  await waitVisible(items.first(), 3000);

  const labels = await items.allTextContents();
  const idx = labels.findIndex(t => normalizeLabel(t) === target); // exact match only
  if (idx === -1) {
    await page.keyboard.press('Escape');
    logger.warn('Model not in menu', { requested: model, available: labels.map(normalizeLabel) });
    return false;
  }
  await items.nth(idx).click();
  await page.waitForTimeout(400);
  return true;
}

async function readPanelModel(page) {
  return normalizeLabel(await page.locator(`${OVERLAY} ${MODEL_TRIGGER}`).first().textContent({ timeout: 3000 }).catch(() => ''));
}

export async function configureGenerationUI(options = {}) {
  // videoInput: "Frames" | "Ingredients"; resolution: "720p" | "360p" (video only)
  const { mode, ratio, model, quantity, duration, videoInput, resolution } = options;
  const page = getPage();
  logger.info('Configuring generation UI', { mode, ratio, model, quantity, duration });

  if (!(await openSettingsPanel(page))) {
    await takeScreenshot(page, 'configure-ui-panel-not-open');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Generation settings panel did not open.');
  }

  // 1. Mode first: it changes which models are listed.
  if (mode && !(await pickToggle(page, mode))) {
    await takeScreenshot(page, 'configure-ui-mode-failed');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `Could not switch to ${mode} mode.`);
  }

  // 2. Model (selecting a menu item may close the panel — reopen after).
  if (model) {
    if (!(await pickModel(page, model))) {
      await closeOverlays(page);
      await takeScreenshot(page, 'configure-ui-model-failed');
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Model "${model}" not found in Flow's model menu.`);
    }
    await openSettingsPanel(page);
  }

  // 3. Ratio, quantity, duration.
  if (ratio && !(await pickToggle(page, ratio))) {
    logger.warn(`Could not select ratio ${ratio}`);
  }
  if (quantity && !(await pickToggle(page, `x${quantity}`))) {
    logger.warn(`Could not select quantity x${quantity}`);
  }
  if (mode === 'Video') {
    if (videoInput && !(await pickToggle(page, videoInput))) logger.warn(`Could not select ${videoInput}`);
    if (resolution && !(await pickToggle(page, resolution))) logger.warn(`Could not select ${resolution}`);
    if (duration) {
      const durStr = String(duration).endsWith('s') ? String(duration) : `${duration}s`;
      if (!(await pickToggle(page, durStr))) logger.warn(`Could not select duration ${durStr}`);
    }
  }

  // Verify the model inside the panel (the video chip doesn't show the model).
  const panelModel = await readPanelModel(page);
  if (model && panelModel !== normalizeLabel(model)) {
    await closeOverlays(page);
    await takeScreenshot(page, 'configure-ui-verify-failed');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      `Model check failed: panel shows "${panelModel}", expected "${model}".`);
  }

  // 4. Close everything and verify via the chip text.
  await closeOverlays(page);
  const chipText = normalizeLabel(
    await page.locator(SETTINGS_TRIGGER).first().textContent().catch(() => '')
  );
  logger.info('Settings chip after configuration', { chipText });

  if (mode && !(mode === 'Video' ? /^video/.test(chipText) : !/^video/.test(chipText))) {
    await takeScreenshot(page, 'configure-ui-verify-failed');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      `Mode check failed: chip shows "${chipText}", expected ${mode} mode.`);
  }
  if (quantity && !new RegExp(`\\bx${quantity}\\b`).test(chipText)) {
    await takeScreenshot(page, 'configure-ui-verify-failed');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
      `Quantity check failed: chip shows "${chipText}", expected x${quantity}.`);
  }
  return { chipText, model: panelModel };
}
