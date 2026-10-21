import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';
import { openMentionPopup, closeMentionPopup } from '../navigation/mentions.js';

/**
 * Open the character page (/project/{id}/character) and list the project's
 * existing characters via the "@" asset picker's Characters tab.
 */
export async function handleOpenCharacters(args = {}) {
  const page = getPage();
  await ensureProjectInContext(page, { name: args.project_name, campaign: args.campaign, project_id: args.project_id });

  // List existing characters from the project page's "@" picker.
  let characters = [];
  const prompt = page.locator('[role="textbox"][aria-label="What do you want to create?"]').first();
  if (await prompt.isVisible({ timeout: 8000 }).catch(() => false)) {
    const popup = await openMentionPopup(page, prompt);
    if (popup) {
      const tab = page.locator('.cdk-overlay-container').getByText(/^\s*Characters\s*$/).first();
      if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(1000);
      }
      characters = (await page.locator('.cdk-overlay-container [role="option"]').allTextContents())
        .map(t => t.replace(/\s+/g, ' ').trim().replace(/\s*Character$/, ''))
        .filter(Boolean);
      await closeMentionPopup(page, prompt);
    }
  }

  await navigateToSidebar(page, 'Characters');
  const archetypes = (await page.locator('button').filter({ hasText: /^\s*The [A-Z]/ }).allTextContents())
    .map(t => t.replace(/\s+/g, ' ').trim().split(' ').slice(0, 2).join(' '));

  return {
    status: 'opened',
    url: page.url(),
    characters,
    archetypes,
    screenshot: await takeScreenshot(page, 'characters-page'),
  };
}
