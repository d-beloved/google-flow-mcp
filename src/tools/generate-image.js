import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { insertMentionReferences } from '../navigation/mentions.js';
import { get } from '../utils/config.js';
import { configureGenerationUI } from '../browser/safe-actions.js';

function selectModel(requested) {
  const available = get('imageModels', {});
  if (!requested || requested === 'auto') {
    return 'Nano Banana 2';
  }
  if (available[requested]) return requested;
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

    if (!args.skip_config) {
      // STEP 4: Configure the generation UI actively to prevent credit wastage
      await configureGenerationUI({
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

    const promptCandidates = [
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
    await promptInput.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    await page.keyboard.type(args.prompt, { delay: 10 });
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
        prompt: args.prompt,
        ingredients_inserted: mentionResults.inserted,
        ingredients_failed: mentionResults.failed,
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
    const generateBtnLocator = page.locator('button:has-text("arrow_forward")').first();
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

    // Set up network interception for image generation *before* clicking Generate
    const interceptedUuids = new Set();
    const responseHandler = async (response) => {
      try {
        const url = response.url();
        // 1. Direct match on media redirect name query parameter
        const redirectMatch = url.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
        if (redirectMatch) {
          interceptedUuids.add(redirectMatch[1]);
          return;
        }

        // 2. Check if it's a tRPC API JSON response containing image metadata
        if (url.includes('api/trpc') && (url.includes('media') || url.includes('task') || url.includes('generate')) && response.status() === 200) {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('application/json')) {
            const data = await response.json().catch(() => null);
            if (data) {
              const text = JSON.stringify(data);
              const matches = text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi);
              if (matches) {
                matches.forEach(uuid => interceptedUuids.add(uuid.toLowerCase()));
              }
            }
          }
        }
      } catch (err) {
        // Safe catch for binary/empty responses
      }
    };
    page.on('response', responseHandler);

    // STEP 10: Click generate ⚠️ CREDITS WILL BE CONSUMED
    logger.info('⚠️⚠️⚠️ Clicking Generate — credits will be consumed');
    await generateBtnLocator.click();

    // STEP 11: Handle two possible generation flows:
    //   A) Agent-mediated: Agent asks "Accept?" before generating (when switching modes)
    //   B) Direct: generation starts immediately (most common)
    // Try Agent first (short wait), fall through to direct if not detected

    let flowMode = 'direct';
    logger.info('Checking for Agent confirmation dialog (5s window)...');
    const acceptTimeoutMs = get('agentResponseTimeoutMs', 5000);
    const acceptStart = Date.now();

    while (Date.now() - acceptStart < acceptTimeoutMs) {
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (pageText.includes('Accept') || pageText.includes('Approve')) {
        logger.info('Agent confirmation dialog detected — switching to Agent flow');
        const acceptBtn = page.getByRole('button', { name: /Accept|Approve/i }).first();
        await acceptBtn.click();
        logger.info('Generation confirmed via Agent');
        flowMode = 'agent';
        break;
      }
      await page.waitForTimeout(200);
    }

    logger.info('Generation flow', { mode: flowMode });

    // STEP 12: Wait for images to appear (Network Interception with DOM fallback)
    logger.info('Waiting for generated images...');
    let generatedImageUuids = [];
    const genTimeoutMs = get('generationTimeoutMs', 120000);
    const genStart = Date.now();

    try {
      while (Date.now() - genStart < genTimeoutMs) {
        await page.waitForTimeout(500);

        if (interceptedUuids.size > 0) {
          generatedImageUuids = [...interceptedUuids];
          logger.info('Generated images detected via network interception', { count: generatedImageUuids.length });
          break;
        }

        // Fallback: Scan DOM just in case network interception missed it
        const domUuids = await page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img'));
          const uuids = [];
          imgs.forEach(img => {
            const src = img.src || '';
            const match = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
            if (match && img.width > 100) {
              uuids.push(match[1]);
            }
          });
          return [...new Set(uuids)];
        }).catch(() => []);

        if (domUuids.length > 0) {
          generatedImageUuids = domUuids;
          logger.info('Generated images detected via DOM fallback', { count: domUuids.length });
          break;
        }

        const hasDownload = await page.locator(
          'text=Download, [aria-label*="download" i]'
        ).first().isVisible().catch(() => false);
        if (hasDownload) {
          logger.info('Download button appeared after generation');
          break;
        }

        if ((Date.now() - genStart) % 30000 === 0) {
          logger.info('Still waiting for images...', { elapsed: Date.now() - genStart });
          await takeScreenshot(page, `gen-wait-${Math.round((Date.now() - genStart) / 1000)}s`);
        }
      }
    } finally {
      page.off('response', responseHandler);
    }

    if (generatedImageUuids.length === 0) {
      await takeScreenshot(page, 'no-images-detected');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Generation completed but no images were detected in the DOM. ' +
        'Check the Flow project content library.');
    }

    // STEP 13: Images are in the project — no download needed.
    // Return the project URL and image UUIDs so the user can view them in the browser.
    const projectUrl = page.url();
    const imageUrls = generatedImageUuids.map(
      uuid => `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${uuid}`
    );

    saveMetadata(job.id, {
      type: 'image',
      model,
      ratio,
      auto_confirm: true,
      quantity: args.quantity || 1,
      prompt: args.prompt,
      ingredients_requested: mentionNames,
      ingredients_inserted: mentionResults.inserted,
      ingredients_failed: mentionResults.failed,
      jobId: job.id,
      imageUuids: generatedImageUuids,
      projectUrl,
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
      image_count: generatedImageUuids.length,
      image_uuids: generatedImageUuids,
      image_urls: imageUrls,
      project_url: projectUrl,
      credits_consumed: true,
      message: `${generatedImageUuids.length} image(s) generated. View them in the project: ${projectUrl}`,
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'generate-image-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
