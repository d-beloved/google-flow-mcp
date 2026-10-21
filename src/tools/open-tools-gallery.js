import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { listTools, openToolByName } from '../navigation/tools.js';

/** Open the Tools gallery and list tools in each tab. */
export async function handleOpenToolsGallery(args = {}) {
  const page = getPage();
  const tools = await listTools(page, { name: args.project_name, project_id: args.project_id });
  return {
    status: 'opened',
    url: page.url(),
    tools,
    screenshot: await takeScreenshot(page, 'tools-gallery'),
  };
}

export async function handleListTools(args = {}) {
  return handleOpenToolsGallery(args);
}

export async function handleOpenTool(args = {}) {
  const page = getPage();
  const name = args.name || args.tool_name;
  if (!name) throw new Error('Tool name is required');
  const tool = await openToolByName(page, name, { name: args.project_name, project_id: args.project_id, tab: args.tab });
  return {
    status: 'opened', tool: tool.name, tab: tool.tab, url: tool.url, frame_loaded: !!tool.frame,
    screenshot: await takeScreenshot(page, `tool-${tool.name.replace(/\W+/g, '-')}`),
  };
}
