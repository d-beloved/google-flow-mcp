import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  // Capture console logs and page errors
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

  console.log('Reloading the page to reset Slate.js state...');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  console.log('Focusing and typing prompt using page.keyboard.type()...');
  const promptInput = page.locator('div[contenteditable="true"][role="textbox"]').first();
  await promptInput.click();
  await page.waitForTimeout(500);

  const promptText = 'Create a simple stickman drawing. Testing clean keyboard type.';
  await page.keyboard.type(promptText, { delay: 15 });
  await page.waitForTimeout(1000);

  // Check if button is enabled
  const button = page.locator('button:has-text("arrow_forward")').first();
  const isDisabled = await button.getAttribute('aria-disabled').then(val => val === 'true').catch(() => true);
  console.log(`Generate button is disabled: ${isDisabled}`);

  console.log('Clicking Generate button...');
  try {
    await button.click();
    console.log('Clicked.');
  } catch (e) {
    console.error('Click failed:', e.message);
  }

  await page.waitForTimeout(5000);

  // Take screenshot
  const screenshotPath = 'screenshots-debug/test-keyboard-type-result.png';
  await page.screenshot({ path: screenshotPath });
  console.log(`Screenshot saved to: ${screenshotPath}`);

  await browser.close();
}

main().catch(console.error);
