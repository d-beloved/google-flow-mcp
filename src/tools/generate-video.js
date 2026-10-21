import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { configureGenerationUI, typeLikeHuman } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';
import { listMedia, waitForNewMedia, downloadMedia, clearPromptIngredients, addMediaToPrompt } from '../browser/media.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { insertMentionReferences } from '../navigation/mentions.js';
import { get } from '../utils/config.js';

const SHORTCUTS = {
  quality: 'Veo 3.1 - Quality', premium: 'Veo 3.1 - Quality',
  fast: 'Veo 3.1 - Fast', speed: 'Veo 3.1 - Fast',
  lite: 'Veo 3.1 - Lite', test: 'Veo 3.1 - Lite',
  flash: 'Omni 1.1 Flash', simple: 'Omni 1.1 Flash', 'Omni Flash': 'Omni 1.1 Flash',
};

function selectVideoModel(requested) {
  const available = get('videoModels', {});
  if (!requested || requested === 'auto') return 'Veo 3.1 - Fast';
  const name = SHORTCUTS[requested] || requested;
  return available[name] ? name : null;
}

export async function handleGenerateVideo(args) {
  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('video_generation', {
    prompt: args.prompt, model: args.model || 'auto', ratio: args.ratio || '16:9',
    duration: args.duration, quantity: args.quantity || 1, auto_confirm: autoConfirm,
    ingredients: args.ingredients, project_name: args.project_name, campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    await ensureProjectInContext(page, {
      name: args.project_name, campaign: args.campaign,
      project_id: args.project_id, forceNew: args.new_project === true,
    });

    const model = selectVideoModel(args.model);
    if (!model) {
      const available = Object.keys(get('videoModels', {}));
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Video model "${args.model}" not available. Available: ${available.join(', ')}`,
        { requested: args.model, available });
    }

    const ratio = args.ratio || '16:9';
    if (!get('videoRatios', ['16:9', '9:16']).includes(ratio)) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE, `Ratio ${ratio} not available for video (16:9 or 9:16).`);
    }
    // Only enforce duration/resolution when asked; otherwise keep the model's own setting.
    const duration = args.duration ? (String(args.duration).endsWith('s') ? String(args.duration) : `${args.duration}s`) : null;
    if (duration && !get('durations', ['4s', '6s', '8s', '10s']).includes(duration)) {
      throw new FlowError(ErrorCodes.INVALID_PARAMS, `Duration ${duration} not available (4s, 6s, 8s, 10s).`);
    }
    const qty = Math.min(Math.max(args.quantity || 1, 1), 4);

    const config = await configureGenerationUI({
      mode: 'Video', ratio, model, duration, quantity: qty,
      videoInput: args.video_input || 'Ingredients',
      resolution: args.resolution || null,
    });

    const promptInput = page.locator('[role="textbox"][aria-label="What do you want to create?"]').first();
    if (!(await promptInput.isVisible({ timeout: 10000 }).catch(() => false))) {
      await takeScreenshot(page, 'no-prompt-input-video');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not find the prompt box ("What do you want to create?").');
    }
    // References persist in the ingredient bar after the text is cleared; drop them
    // so one prompt's references never leak into the next.
    if (args.keep_ingredients !== true) await clearPromptIngredients(page);
    await promptInput.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await typeLikeHuman(page.keyboard, args.prompt);

    const mentionNames = [
      ...(Array.isArray(args.ingredients) ? args.ingredients : []),
      ...(args.use_character ? [args.use_character] : []),
      ...(args.use_scene ? [args.use_scene] : []),
    ];
    let mentionResults = { inserted: [], failed: [] };
    if (mentionNames.length) mentionResults = await insertMentionReferences(page, promptInput, mentionNames);

    const refsAttached = [];
    const refsFailed = [];
    for (const ref of (Array.isArray(args.reference_media) ? args.reference_media : [])) {
      ((await addMediaToPrompt(page, ref)) ? refsAttached : refsFailed).push(ref);
    }
    if (refsFailed.length) logger.warn('Some reference_media could not be attached', { refsFailed });

    const base = {
      type: 'video', account: get('expectedAccount'), model_used: model, ratio,
      duration: duration || ((config.chipText.match(/\b(\d+s)\b/) || [])[1] ?? null),
      quantity: qty, chip: config.chipText, prompt: args.prompt,
      credit_cost: config.creditCost?.credits ?? null, credit_cost_text: config.creditCost?.text ?? null,
      ingredients_inserted: mentionResults.inserted, ingredients_failed: mentionResults.failed,
      reference_media_attached: refsAttached, reference_media_failed: refsFailed,
    };

    if (!autoConfirm) {
      const screenshot = await takeScreenshot(page, 'video-ready-for-confirmation');
      const result = { ...base, status: 'ready_for_confirmation', screenshot, jobId: job.id,
        message: '✅ Video set up. No credits consumed. Call again with auto_confirm=true to generate (uses credits).' };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    const generateBtn = page.locator('button[aria-label="Start generation"]').first();
    if (!(await generateBtn.isEnabled({ timeout: 5000 }).catch(() => false))) {
      await takeScreenshot(page, 'video-generate-disabled');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button is disabled.');
    }
    const beforeIds = await listMedia(page); // full list: count-based detection
    logger.info('⚠️ Clicking Generate for VIDEO — credits will be consumed', { model, duration, qty });
    await generateBtn.click();

    const acceptBtn = page.getByRole('button', { name: /^(Accept|Approve)$/ }).first();
    if (await acceptBtn.isVisible({ timeout: 5000 }).catch(() => false)) await acceptBtn.click();

    const media = await waitForNewMedia(page, beforeIds, {
      count: qty, type: 'video', timeoutMs: get('videoGenerationTimeoutMs', 600000),
    });

    const downloads = [];
    const downloadErrors = [];
    if (args.download && String(args.download).toLowerCase() !== 'none') {
      for (const m of media) {
        try { downloads.push(await downloadMedia(page, m.id, { size: args.download, type: 'video' })); }
        catch (e) { downloadErrors.push({ mediaId: m.id, error: e.message }); }
      }
    }

    const result = { ...base, status: 'success', credits_consumed: true, project_url: page.url(),
      media_ids: media.map(m => m.id), titles: media.map(m => m.title), downloads, download_errors: downloadErrors,
      message: `${media.length} video(s) generated` + (downloads.length ? `; downloaded to ${downloads.map(d => d.path).join(', ')}` : '') + '.' };
    saveMetadata(job.id, { ...result, jobId: job.id });
    jobQueue.completeJob(job.id, result);
    return result;
  } catch (err) {
    await takeScreenshot(getPage(), 'generate-video-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
