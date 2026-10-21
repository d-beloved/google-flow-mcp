import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { detectPageElements, typeLikeHuman } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';
import { renameCharacterTitle } from '../navigation/character-rename.js';

// Character creation page (verified 2026-10-21): /project/{id}/character
//   archetype buttons ("The Eccentric", "The Professional", ...)
//   [role=textbox][aria-label="Describe your character…"]
//   button[aria-label="Select model family"]  (menu of models)
//   button "Upload", button "Add from project"
//   button[aria-label="Start generation"]  ⚠️ uses credits
export async function handleCreateCharacter(args) {
  const autoConfirm = args.auto_confirm === true; // default: prepare only
  const job = jobQueue.createJob('create_character', { ...args, auto_confirm: autoConfirm });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    await ensureProjectInContext(page, {
      name: args.project_name, campaign: args.campaign, project_id: args.project_id,
    });
    await navigateToSidebar(page, 'Characters');

    const desc = page.locator('[role="textbox"][aria-label^="Describe your character"]').first();
    if (!(await desc.isVisible({ timeout: 10000 }).catch(() => false))) {
      await takeScreenshot(page, 'character-form-missing');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Character form ("Describe your character…") not found.');
    }

    if (args.archetype) {
      const arch = page.locator('button').filter({ hasText: new RegExp(`^\\s*${args.archetype.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') }).first();
      if (await arch.isVisible({ timeout: 2000 }).catch(() => false)) await arch.click();
      else logger.warn('Archetype not found', { archetype: args.archetype });
    }

    await desc.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await typeLikeHuman(page.keyboard, args.description);

    const refImages = Array.isArray(args.reference_images) ? args.reference_images
      : (args.reference_image ? [args.reference_image] : []);
    if (refImages.length) {
      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.count()) {
        await fileInput.setInputFiles(refImages);
        await page.waitForTimeout(1500);
      } else {
        logger.warn('No file input on character page; skipping reference images');
      }
    }

    if (args.model) {
      const modelBtn = page.locator('button[aria-label="Select model family"]').first();
      if (await modelBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await modelBtn.click();
        const item = page.locator('.cdk-overlay-container [role="menuitem"]')
          .filter({ hasText: new RegExp(`${args.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first();
        if (await item.isVisible({ timeout: 3000 }).catch(() => false)) await item.click();
        else { await page.keyboard.press('Escape'); logger.warn('Character model not found', { model: args.model }); }
      }
    }

    if (!autoConfirm) {
      const result = {
        status: 'ready_for_confirmation', type: 'character', name: args.name, description: args.description,
        message: 'Character form filled. No credits used. Call again with auto_confirm=true to create it.',
        screenshot: await takeScreenshot(page, 'character-ready'),
      };
      saveMetadata(job.id, { ...result, jobId: job.id });
      jobQueue.completeJob(job.id, result);
      return result;
    }

    const submit = page.locator('button[aria-label="Start generation"]').first();
    if (!(await submit.isEnabled({ timeout: 5000 }).catch(() => false))) {
      await takeScreenshot(page, 'character-submit-disabled');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Character "Start generation" button is disabled.');
    }
    logger.info('⚠️ Creating character — credits will be consumed');
    await submit.click();

    const navigated = await page.waitForURL(u => /\/character\/[^/]+/.test(u.pathname), { timeout: get('characterTimeoutMs', 180000) })
      .then(() => true).catch(() => false);
    if (!navigated) {
      await takeScreenshot(page, 'character-timeout');
      throw new FlowError(ErrorCodes.GENERATION_TIMEOUT, 'Character creation did not finish (no character page opened).');
    }

    const renamed = args.name ? await renameCharacterTitle(page, args.name) : false;
    const result = {
      status: 'success', type: 'character', name: args.name, renamed, description: args.description,
      character_url: page.url(), credits_consumed: true,
      message: 'Character created.' + (args.name ? (renamed ? ` Renamed to "${args.name}".` : ` Could not rename to "${args.name}".`) : ''),
      screenshot: await takeScreenshot(page, 'character-created'),
    };
    saveMetadata(job.id, { ...result, jobId: job.id });
    jobQueue.completeJob(job.id, result);
    return result;
  } catch (err) {
    try { await takeScreenshot(getPage(), 'create-character-error'); } catch { /* ok */ }
    jobQueue.failJob(job.id, err);
    throw err;
  }
}

export async function handleListCharacters() {
  const page = getPage();
  await navigateToSidebar(page, 'Characters');
  
  // Wait for the UI of the characters section to settle
  const anchor = page.locator('button:has-text("New Character"), button:has-text("New character"), [class*="card"]').first();
  await anchor.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});

  const elements = await detectPageElements(page);
  const characterCards = elements.buttons.filter(b =>
    !b.text.includes('New') && !b.text.includes('Create') && b.text.length > 2
  );

  return {
    status: 'success',
    characters_found: characterCards,
    raw_elements: elements,
    screenshot: await takeScreenshot(page, 'characters-list'),
  };
}
