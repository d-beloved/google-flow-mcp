import { launchChromeDirect, closeBrowser } from './src/browser/connect.js';
import { ensureProjectInContext } from './src/navigation/project-navigator.js';
import { takeScreenshot } from './src/utils/screenshots.js';

async function main() {
  try {
    console.log('1. Launching Chrome with KiaraFlow profile...');
    const { page } = await launchChromeDirect({
      headless: false
    });

    console.log('2. Navigating to Google Flow...');
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    if (!currentUrl.includes('/project/') && !currentUrl.includes('accounts.google.com')) {
      const createBtn = page.locator('a:has-text("Create with Google Flow"), button:has-text("Create with Google Flow")').first();
      if (await createBtn.isVisible().catch(() => false)) {
        console.log('Clicking "Create with Google Flow" to open sign-in page...');
        await createBtn.click();
        await page.waitForTimeout(4000);
      }
    }

    console.log('3. Checking if logged in (waiting for user sign-in)...');
    let loggedIn = false;
    for (let i = 0; i < 60; i++) { // Wait up to 600 seconds (10 minutes)
      const url = page.url();
      const hasNewProject = await page.locator('button:has-text("New project"), a:has-text("New project")').first().isVisible().catch(() => false);
      const inProject = url.includes('/project/');

      if (hasNewProject || inProject) {
        loggedIn = true;
        console.log('Successfully logged in!');
        break;
      }

      console.log(`[${i*10}s] Current URL: ${url.substring(0, 90)}. Please complete sign-in directly in the opened Chrome window...`);
      await page.waitForTimeout(10000);
    }

    if (!loggedIn) {
      console.error('Timeout waiting for sign-in. Please try again.');
      await takeScreenshot(page, 'sign-in-timeout');
      process.exit(1);
    }

    console.log('4. Creating the new project...');
    const result = await ensureProjectInContext(page, {
      name: "Creative Campaign Project",
      forceNew: true
    });

    console.log('SUCCESS! Project created:');
    console.log(JSON.stringify(result, null, 2));

    const finalSS = await takeScreenshot(page, 'project-created-success');
    console.log('Screenshot saved to:', finalSS);

    console.log('Automation complete. Keeping Chrome open for your use.');
    process.exit(0);
  } catch (e) {
    console.error('Automation error:', e);
    process.exit(1);
  }
}

main();
