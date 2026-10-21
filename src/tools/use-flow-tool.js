import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { openToolByName, fillToolParams } from '../navigation/tools.js';

/**
 * Open a Flow tool by name and (best effort) fill its fields.
 * Tools run in a sandboxed iframe; params are matched by field label,
 * placeholder or name. Never clicks a tool's generate/run button.
 */
export async function handleUseFlowTool(args = {}) {
  const page = getPage();
  const name = args.tool_name || args.name;
  if (!name) throw new Error('Tool name is required');

  const tool = await openToolByName(page, name, {
    name: args.project_name, campaign: args.campaign, project_id: args.project_id, tab: args.tab,
  });
  const fill = args.params && typeof args.params === 'object'
    ? await fillToolParams(page, args.params)
    : { filled: [], missing: [] };

  return {
    status: 'ready_for_confirmation',
    tool: tool.name,
    tab: tool.tab,
    url: tool.url,
    frame_loaded: !!tool.frame,
    params_filled: fill.filled,
    params_not_found: fill.missing,
    message: 'Tool opened. Review it in Flow and run it there (running a tool can use credits).',
    screenshot: await takeScreenshot(page, `tool-${tool.name.replace(/\W+/g, '-')}-setup`),
  };
}
