import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { saveMetadata } from '../utils/file-manager.js';
import { listMedia, waitForNewMedia, downloadMedia, clearPromptIngredients, addMediaToPrompt } from '../browser/media.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { insertMentionReferences } from '../navigation/mentions.js';
import { get } from '../utils/config.js';
import { configureGenerationUI, typeLikeHuman } from '../browser/safe-actions.js';

// Old names still accepted; Flow renamed "Nano Banana 2" to "Nano Banana 2.1".
const MODEL_ALIASES = { 'Nano Banana 2': 'Nano Banana 2.1' };

function selectModel(requested) {
  const available = get('imageModels', {});
  if (!requested || requested === 'auto') {
    return 'Nano Banana 2.1';
  }
  const name = MODEL_ALIASES[requested] || requested;
  if (available[name]) return name;
  return null;
}

function selectRatio(requested) {
  const ratios = get('ratios', []);
  if (!requested || ratios.includes(requested)) {
    return requested || '16:9';
  }
  return null;
}

export async function handleGenerateImage(args) {
  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('image_generation', {
    prompt: args.prompt,
    model: args.model || 'auto',
    ratio: args.ratio || '16:9',
    auto_confirm: autoConfirm,
    quantity: args.quantity || 1,
    outputFolder: args.output_folder,
    useCharacter: args.use_character,
    useScene: args.use_scene,
    useTool: args.use_tool,
    references: args.references,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // STEP 1: Ensure we're in a project context
    await ensureProjectInContext(page, {
      name: args.project_name,
      campaign: args.campaign,
      project_id: args.project_id,
      forceNew: args.new_project === true,
    });

    // STEP 2: Model selection (config-level, before UI interaction)
    const model = selectModel(args.model);
    if (!model) {
      const available = Object.keys(get('imageModels', {}));
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Model "${args.model}" not available. Available: ${available.join(', ')}`,
        { requested: args.model, available });
    }
    logger.info('Using model', { model });

    // 🛡️ SAFETY: Verify model is an IMAGE model, NOT a video model
    const imageModels = get('imageModels', {});
    const videoModels = get('videoModels', {});
    if (!imageModels[model]) {
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `🚨 SAFETY BLOCK: "${model}" is a VIDEO model, not an IMAGE model. ` +
        `Use flow_generate_video for videos. Image models: ${Object.keys(imageModels).join(', ')}`);
    }
    if (videoModels[model]) {
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `🚨 SAFETY BLOCK: "${model}" is also a VIDEO model. ` +
        `Refusing to generate to avoid consuming video credits. Image models: ${Object.keys(imageModels).join(', ')}`);
    }

    // STEP 3: Ratio selection
    const ratio = selectRatio(args.ratio);
    if (!ratio) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE,
        `Ratio "${args.ratio}" not available. Available: ${get('ratios', []).join(', ')}`);
    }

    let uiConfig = null;
    if (!args.skip_config) {
      // STEP 4: Configure the generation UI actively to prevent credit wastage
      uiConfig = await configureGenerationUI({
        mode: 'Image',
        ratio,
        model,
        quantity: args.quantity || 1
      });
    } else {
      logger.info('Skipping generation UI configuration as requested');
    }

    // Double check model selector confirms IMAGE mode (NOT video)
    const modelFromUI = await page.evaluate(() => {
      const modelBtn = Array.from(document.querySelectorAll('button'))
        .find(b => {
          const text = b.textContent || '';
          return (text.includes('Nano') || text.includes('Banana') ||
                  text.includes('Omni') || text.includes('Veo') ||
                  text.includes('Imagen')) && b.offsetParent !== null;
        });
      return modelBtn ? modelBtn.textContent.trim().replace(/\s+/g, ' ').substring(0, 80) : null;
    }).catch(() => null);

    if (modelFromUI) {
      logger.info('Model selector shows:', { modelFromUI });
      const videoModelNames = ['Omni Flash', 'Veo', 'Omni'];
      const isVideoModel = videoModelNames.some(v => modelFromUI.includes(v));
      if (isVideoModel) {
        await takeScreenshot(page, 'video-model-detected');
        throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
          `🚨 SAFETY BLOCK: The model "${modelFromUI}" is a VIDEO model. ` +
          `Refusing to generate to avoid consuming paid video credits. ` +
          `Use flow_generate_video for videos.`);
      }
      logger.info('✅ Model selector confirms image mode');
    } else {
      logger.warn('Could not read model selector after configuration');
    }

    // Also verify the generate button exists (confirms the toolbar is active)
    const hasGenerateBtn = await page.getByRole('button', { name: /arrow_forward|Generate|Create/i })
      .first().isVisible().catch(() => false);
    if (!hasGenerateBtn) {
      logger.warn('Generate button not visible on project page');
    }

    // STEP 5: Find the prompt input (contenteditable div at bottom toolbar)
    let promptInput = null;

    // Current Flow UI: ProseMirror div with this aria-label. Wait for it to render.
    const knownPrompt = page.locator('[role="textbox"][aria-label="What do you want to create?"]').first();
    await knownPrompt.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

    const promptCandidates = [
      knownPrompt,
      page.locator('div[contenteditable="true"][role="textbox"]').first(),
      page.locator('div[role="textbox"]').first(),
      page.locator('div[contenteditable="true"]').first(),
      page.getByRole('textbox').first(),
      page.locator('[contenteditable="true"]:visible').first(),
      page.locator('textarea:visible').first(),
      page.locator('textarea').first(),
    ];

    for (const candidate of promptCandidates) {
      if (await candidate.isVisible().catch(() => false)) {
        promptInput = candidate;
        logger.info('Found prompt input on page');
        break;
      }
    }

    if (!promptInput) {
      await takeScreenshot(page, 'no-prompt-input');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Could not find prompt input field inside the project. ' +
        'The Flow UI may have changed. Expected [contenteditable] or textarea.'
      );
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // STEP 6: Fill the prompt
    // References persist in the ingredient bar after the text is cleared; drop them
    // so one prompt's references never leak into the next.
    if (args.keep_ingredients !== true) await clearPromptIngredients(page);
    await promptInput.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    await typeLikeHuman(page.keyboard, args.prompt);
    logger.info('Prompt filled', { promptLength: args.prompt.length });
    await page.waitForTimeout(200);

    // Insert "@" references for any existing images/characters to use as ingredients.
    // Flow opens a popup when "@" is typed, listing project images and characters.
    const mentionNames = Array.isArray(args.ingredients) ? args.ingredients : [];
    let mentionResults = { inserted: [], failed: [] };
    if (mentionNames.length > 0) {
      mentionResults = await insertMentionReferences(page, promptInput, mentionNames);
      if (mentionResults.failed.length > 0) {
        logger.warn('Some @ mention references could not be inserted', {
          failed: mentionResults.failed,
        });
      }
      await page.waitForTimeout(200);
    }

    const refsAttached = [];
    const refsFailed = [];
    for (const ref of (Array.isArray(args.reference_media) ? args.reference_media : [])) {
      ((await addMediaToPrompt(page, ref)) ? refsAttached : refsFailed).push(ref);
    }
    if (refsFailed.length) logger.warn('Some reference_media could not be attached', { refsFailed });

    // ⚠️ STEP 7: DECISION POINT — auto_confirm determines if we click Generate
    if (!autoConfirm) {
      // SAFE MODE: Setup only, no click. Return "ready_for_confirmation".
      const setupScreenshot = await takeScreenshot(page, 'image-ready-for-confirmation');
      const result = {
        status: 'ready_for_confirmation',
        type: 'image',
        message: '✅ Prompt, model and ratio are ready. No credits consumed. ' +
          'To generate and consume credits, call again with auto_confirm=true.',
        model_used: model,
        ratio,
        credit_cost: uiConfig?.creditCost?.credits ?? null,
        credit_cost_text: uiConfig?.creditCost?.text ?? null,
        prompt: args.prompt,
        ingredients_inserted: mentionResults.inserted,
        ingredients_failed: mentionResults.failed,
        reference_media_attached: refsAttached,
        reference_media_failed: refsFailed,
        account: get('expectedAccount'),
        screenshot: setupScreenshot,
        jobId: job.id,
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    // 🛡️ SAFETY: Pre-generation screenshot verification
    logger.info('⚠️ auto_confirm=true — running safety checks before clicking Generate');
    const preGenScreenshot = await takeScreenshot(page, 'pre-generate-verification');

    // STEP 8: Find generate button
    const knownGenerateBtn = page.locator('button[aria-label="Start generation"]').first();
    const generateBtnLocator = (await knownGenerateBtn.isVisible().catch(() => false))
      ? knownGenerateBtn
      : page.locator('button:has-text("arrow_forward")').first();
    const generateBtnVisible = await generateBtnLocator.isVisible().catch(() => false);
    if (!generateBtnVisible) {
      await takeScreenshot(page, 'no-generate-btn');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button not found');
    }

    // Wait up to 5 seconds for the button to become enabled (allowing React state to catch up)
    logger.info('Waiting for generate button to be enabled...');
    let buttonEnabled = false;
    for (let check = 0; check < 10; check++) {
      const isDisabled = await generateBtnLocator.isDisabled().catch(() => false);
      if (!isDisabled) {
        buttonEnabled = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    if (!buttonEnabled) {
      await takeScreenshot(page, 'generate-disabled');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button is disabled');
    }

    // Snapshot existing media so we can spot the new result(s).
    const beforeIds = await listMedia(page); // full list: count-based detection

    // STEP 10: Click generate ⚠️ CREDITS WILL BE CONSUMED
    logger.info('⚠️⚠️⚠️ Clicking Generate — credits will be consumed');
    await generateBtnLocator.click();

    // STEP 11: If the Agent asks for approval, accept (exact button names only).
    let flowMode = 'direct';
    const acceptBtn = page.getByRole('button', { name: /^(Accept|Approve)$/ }).first();
    if (await acceptBtn.isVisible({ timeout: get('agentResponseTimeoutMs', 5000) }).catch(() => false)) {
      await acceptBtn.click();
      flowMode = 'agent';
      logger.info('Generation confirmed via Agent');
    }
    logger.info('Generation flow', { mode: flowMode });

    // STEP 12: Wait for the new image tile(s).
    const quantity = args.quantity || 1;
    const media = await waitForNewMedia(page, beforeIds, {
      count: quantity, type: 'image', timeoutMs: get('generationTimeoutMs', 180000),
    });
    logger.info('Generated images detected', { count: media.length, ids: media.map(m => m.id) });

    // STEP 13: Optional download (default 2K upscaled; "none" to skip).
    const downloadSize = args.download === undefined ? get('defaultImageDownload', '2K') : args.download;
    const downloads = [];
    const downloadErrors = [];
    if (downloadSize && String(downloadSize).toLowerCase() !== 'none') {
      for (const m of media) {
        try {
          downloads.push(await downloadMedia(page, m.id, { size: downloadSize, type: 'image' }));
        } catch (e) {
          logger.warn('Download failed', { mediaId: m.id, error: e.message });
          downloadErrors.push({ mediaId: m.id, error: e.message });
        }
      }
    }

    const projectUrl = page.url();
    saveMetadata(job.id, {
      type: 'image', model, ratio, auto_confirm: true, quantity, prompt: args.prompt,
      ingredients_requested: mentionNames,
      ingredients_inserted: mentionResults.inserted,
      ingredients_failed: mentionResults.failed,
      jobId: job.id, media, downloads, downloadErrors, projectUrl,
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'image',
      account: get('expectedAccount'),
      model_used: model,
      ratio,
      prompt: args.prompt,
      ingredients_inserted: mentionResults.inserted,
      ingredients_failed: mentionResults.failed,
      reference_media_attached: refsAttached,
      reference_media_failed: refsFailed,
      image_count: media.length,
      media_ids: media.map(m => m.id),
      titles: media.map(m => m.title),
      downloads,
      download_errors: downloadErrors,
      project_url: projectUrl,
      credits_consumed: true,
      credit_cost: uiConfig?.creditCost?.credits ?? null,
      message: `${media.length} image(s) generated` +
        (downloads.length ? `; ${downloads.length} downloaded (${downloadSize}) to ${downloads.map(d => d.path).join(', ')}` : '') +
        (downloadErrors.length ? `; ${downloadErrors.length} download(s) failed` : '') + '.',
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'generate-image-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
