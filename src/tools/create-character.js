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

export async function handleCreateCharacter(args) {
  const job = jobQueue.createJob('create_character', {
    ...args,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // Ensure we're inside a project
    await ensureProjectInContext(page, {
      name: args.project_name,
      campaign: args.campaign,
    });

    // Navigate to the Characters sidebar section
    await navigateToSidebar(page, 'Characters');
    
    // Wait for the Characters section UI to settle
    const characterUIAnchor = page.locator('[placeholder*="Describe your character" i], button:has-text("New Character"), button:has-text("New character")').first();
    await characterUIAnchor.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});

    await takeScreenshot(page, 'characters-section');

    // Are we already on the "New character" creation form?
    const onCreateForm = await page.locator(
      '[placeholder*="Describe your character" i], ' +
      '[data-placeholder*="Describe your character" i], ' +
      '[aria-label*="Describe your character" i], ' +
      '[contenteditable="true"]:visible'
    ).first().isVisible().catch(() => false);

    if (!onCreateForm) {
      const newCharLocator = page.getByRole('button', { name: /New character|Create character/i }).first();

      if (!await newCharLocator.isVisible().catch(() => false)) {
        const elements = await detectPageElements(page);
        return {
          status: 'ui_discovered',
          message: 'Characters section opened. Neither the character creation form nor a "New Character" button was auto-detected.',
          elements: {
            buttons: elements.buttons.map(b => b.text),
            inputs: elements.inputs,
          },
          screenshot: await takeScreenshot(page, 'characters-ui'),
        };
      }

      await newCharLocator.click();
      
      // Wait for description input to become visible after opening form
      const formInput = page.locator('[placeholder*="Describe your character" i], [contenteditable="true"]:visible').first();
      await formInput.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    }

    // Fill character description
    const descCandidates = [
      page.getByRole('textbox').first(),
      page.locator('[placeholder*="Describe your character" i]').first(),
      page.locator('[data-placeholder*="Describe your character" i]').first(),
      page.locator('[aria-label*="Describe" i]').first(),
      page.locator('[contenteditable="true"]:visible').first(),
      page.locator('textarea:visible').first(),
    ];
    let descLocator = null;
    for (const candidate of descCandidates) {
      if (await candidate.isVisible().catch(() => false)) {
        descLocator = candidate;
        break;
      }
    }
    if (descLocator) {
      await descLocator.click();
      try { await descLocator.fill(''); } catch { /* ignore if contenteditable */ }
      await page.waitForTimeout(100);
      await typeLikeHuman(descLocator, args.description);
    } else {
      logger.warn('Could not find character description input');
    }

    // Upload reference image(s) if provided
    const refImages = Array.isArray(args.reference_images) && args.reference_images.length > 0
      ? args.reference_images
      : (args.reference_image ? [args.reference_image] : []);

    if (refImages.length > 0) {
      const fileLocator = page.locator('input[type="file"]').first();
      if (await fileLocator.isVisible().catch(() => false)) {
        await fileLocator.setInputFiles(refImages);
        await page.waitForTimeout(500); // Allow upload transition
        logger.info('Reference image(s) uploaded', { count: refImages.length });
      }
    }

    // Try to select model
    if (args.model) {
      try {
        const modelLocator = page.getByRole('button', { name: args.model }).first();
        if (await modelLocator.isVisible().catch(() => false)) {
          await modelLocator.click();
          await page.waitForTimeout(200);
        }
      } catch { /* ok */ }
    }

    await takeScreenshot(page, 'character-ready');

    if (args.auto_confirm === false) {
      saveMetadata(job.id, {
        type: 'character',
        description: args.description,
        model: args.model,
        referenceImages: refImages,
        projectName: args.project_name,
        campaign: args.campaign,
        jobId: job.id,
        status: 'ready_for_confirmation',
      });

      jobQueue.completeJob(job.id, {
        status: 'ready_for_confirmation',
        type: 'character',
        description: args.description,
        message: 'Character setup complete. Manual confirmation needed to create.',
        screenshot: await takeScreenshot(page, 'character-ready'),
      });

      return jobQueue.getJob(job.id).result;
    }

    // STEP: Click the description textbox (ensure focus), then click submit
    if (descLocator && await descLocator.isVisible().catch(() => false)) {
      await descLocator.click();
      await page.waitForTimeout(100);
    }

    // Find the submit button
    let submitBtn = null;
    const submitSelectors = [
      'button:has-text("arrow_forward")',
      'button[aria-label*="Create character" i]',
      'button[aria-label*="create" i]',
      'button:has-text("Create")',
      'button[aria-label*="Submit" i]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Generate" i]',
      'button[type="submit"]',
    ];
    
    // Check semantic locator first
    const semanticSubmit = page.getByRole('button', { name: /arrow_forward|Create character|Create|Submit|Send|Generate/i }).first();
    if (await semanticSubmit.isVisible().catch(() => false)) {
      submitBtn = semanticSubmit;
      logger.info('Found submit button via semantic role');
    } else {
      for (const sel of submitSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
          submitBtn = btn;
          logger.info('Found submit button via selector', { sel });
          break;
        }
      }
    }

    // JS fallback
    if (!submitBtn) {
      const submitBtnHandle = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => {
          if (!btn.offsetParent) return false;
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (label.includes('send') || label.includes('create') || label.includes('submit') || label.includes('generate')) return true;
          const spans = Array.from(btn.querySelectorAll('span, mat-icon, [class*="icon"]'));
          return spans.some(s => {
            const txt = s.textContent || '';
            return txt.includes('\uE5C8') || txt.trim() === 'arrow_forward' ||
                   txt.includes('send') || txt.includes('chevron_right');
          });
        }) || null;
      }).catch(() => null);

      if (submitBtnHandle) {
        submitBtn = page.locator('button').filter({ has: page.locator('[class*="icon"], mat-icon, span') }).first();
        try {
          const el = submitBtnHandle.asElement();
          if (el) {
            submitBtn = { click: () => el.click(), isDisabled: async () => false, isVisible: async () => true };
          }
        } catch { /* keep locator */ }
      }
    }

    if (!submitBtn) {
      await takeScreenshot(page, 'character-submit-not-found');
      const elements = await detectPageElements(page);
      return {
        status: 'ui_discovered',
        message: 'Description filled, but the submit button was not found. Check screenshot.',
        elements: {
          buttons: elements.buttons.map(b => b.text),
          inputs: elements.inputs,
        },
        screenshot: await takeScreenshot(page, 'character-submit-not-found'),
      };
    }

    const isDisabled = typeof submitBtn.isDisabled === 'function'
      ? await submitBtn.isDisabled().catch(() => false)
      : false;
    if (isDisabled) {
      await takeScreenshot(page, 'character-submit-disabled');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Character submit button is disabled');
    }

    await submitBtn.click();
    logger.info('Character creation submitted — waiting for navigation to character page');

    // Wait for navigation to /character/ URL (up to 30s)
    let navigated = false;
    try {
      await page.waitForURL(url => url.pathname.includes('/character/'), { timeout: 30000 });
      logger.info('Navigated to character page', { url: page.url() });
      navigated = true;
    } catch (e) {
      logger.warn('Failed to navigate to character page', { error: e.message });
      // Check if an error dialog appeared
      const hasError = await page.locator('[role="alert"], [class*="error"], [class*="Error"]').first().isVisible().catch(() => false);
      if (hasError) {
        const errorText = await page.locator('[role="alert"], [class*="error"]').first().textContent().catch(() => 'Unknown error');
        logger.warn('Error dialog appeared after submit', { errorText });
        await takeScreenshot(page, 'character-submit-error-dialog');
      }
    }

    const characterUrl = page.url();
    if (!navigated && !characterUrl.includes('/character/')) {
      throw new FlowError(ErrorCodes.GENERATION_TIMEOUT, 'Character generation timed out or failed to navigate to the character page.');
    }

    // Rename the character title if name is provided
    let renamed = false;
    if (args.name) {
      renamed = await renameCharacterTitle(page, args.name);
    }

    await takeScreenshot(page, 'character-created');

    saveMetadata(job.id, {
      type: 'character',
      name: args.name,
      description: args.description,
      model: args.model,
      referenceImages: refImages,
      projectName: args.project_name,
      campaign: args.campaign,
      jobId: job.id,
      characterUrl,
      renamed,
      status: 'success',
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'character',
      name: args.name,
      renamed,
      description: args.description,
      character_url: characterUrl,
      message: 'Character created.' + (args.name ? (renamed ? ` Renamed to "${args.name}".` : ` Could not rename to "${args.name}" — still "Untitled Character".`) : ''),
      screenshot: await takeScreenshot(page, 'character-created'),
    });

    return jobQueue.getJob(job.id).result;
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
