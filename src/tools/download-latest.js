import { getPage } from '../browser/connect.js';
import { logger } from '../utils/logger.js';
import { listMedia, downloadMedia } from '../browser/media.js';
import { ensureProjectInContext, extractProjectId } from '../navigation/project-navigator.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';

/**
 * Download media from a Flow project.
 * args.size      "1K" | "2K" | "4K" for images (default config defaultImageDownload, 2K).
 *                For videos, the label prefix Flow offers (default: first option).
 * args.count     how many of the newest items to download (default 1)
 * args.media_id  download this specific item instead
 * args.type      "image" | "video" (default: whatever the newest item is)
 * args.project_name / args.project_id  open that project first
 */
export async function handleDownloadLatest(args = {}) {
  const page = getPage();
  if (args.project_name || args.project_id || !extractProjectId(page.url())) {
    await ensureProjectInContext(page, { name: args.project_name, project_id: args.project_id });
  }
  await page.locator('[data-media-id]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  let media = (await listMedia(page)).filter(m => m.ready);
  if (args.type) media = media.filter(m => m.type === args.type);
  if (args.media_id) media = media.filter(m => m.id === args.media_id);
  if (!media.length) {
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'No downloadable media found in this project.');
  }

  const targets = media.slice(0, Math.max(1, args.count || 1));
  const results = [];
  const errors = [];
  for (const m of targets) {
    const size = args.size || (m.type === 'image' ? get('defaultImageDownload', '2K') : get('defaultVideoDownload', '720p'));
    try {
      results.push({ ...(await downloadMedia(page, m.id, { size, type: m.type })), title: m.title, type: m.type });
    } catch (e) {
      logger.warn('Download failed', { mediaId: m.id, error: e.message });
      errors.push({ mediaId: m.id, title: m.title, error: e.message });
    }
  }
  return {
    status: results.length ? 'downloaded' : 'failed',
    project_url: page.url(),
    downloads: results,
    errors,
  };
}
