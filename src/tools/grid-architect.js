import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { saveMetadata } from '../utils/file-manager.js';
import { openToolByName, fillToolParams } from '../navigation/tools.js';

/**
 * Open Grid Architect (Templates tab) and best-effort fill its fields.
 * The tool runs in a sandboxed iframe; fields are matched by label/placeholder.
 * Does not click generate.
 */
export async function handleUseGridArchitect(args = {}) {
  const job = jobQueue.createJob('grid_architect', { ...args });
  try {
    jobQueue.startJob(job.id);
    const page = getPage();
    const tool = await openToolByName(page, 'Grid Architect', {
      name: args.project_name, campaign: args.campaign, project_id: args.project_id, tab: 'Templates',
    });

    const params = {};
    if (args.theme_prompt) params['Theme'] = args.theme_prompt;
    (args.shot_prompts || []).forEach((p, i) => { params[`Shot ${i + 1}`] = p; });
    if (args.engine) params['Model'] = args.engine;
    if (args.ratio) params['Aspect ratio'] = args.ratio;
    if (args.visual_logic) params['Visual logic'] = args.visual_logic;
    const fill = await fillToolParams(page, params);

    const result = {
      status: 'ready_for_confirmation',
      type: 'grid_architect',
      url: tool.url,
      frame_loaded: !!tool.frame,
      params_filled: fill.filled,
      params_not_found: fill.missing,
      message: 'Grid Architect opened. Fields that could not be matched are listed in params_not_found — fill those in Flow. Generating uses credits.',
      screenshot: await takeScreenshot(page, 'grid-architect-ready'),
    };
    saveMetadata(job.id, { ...result, args });
    jobQueue.completeJob(job.id, result);
    return result;
  } catch (err) {
    await takeScreenshot(getPage(), 'grid-architect-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
