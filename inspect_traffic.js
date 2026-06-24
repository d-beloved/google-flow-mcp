import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  console.log('Clearing existing prompt...');
  const clearBtn = page.locator('button:has-text("Clear prompt")').first();
  if (await clearBtn.isVisible().catch(() => false)) {
    await clearBtn.click();
    await page.waitForTimeout(500);
  }

  // Double check and clear div contenteditable manually
  await page.evaluate(() => {
    const box = document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (box) box.textContent = '';
  });

  const promptInput = page.locator('div[contenteditable="true"][role="textbox"]').first();
  await promptInput.click();
  await promptInput.fill('');
  await page.waitForTimeout(100);
  await promptInput.type('Create a simple stickman drawing. Test.', { delay: 15 });

  console.log('Setting up network logger...');
  page.on('request', request => {
    const url = request.url();
    if (url.includes('api/trpc')) {
      console.log(`[REQ] ${url}`);
    }
  });

  page.on('response', async response => {
    const url = response.url();
    if (url.includes('api/trpc')) {
      console.log(`[RESP] ${url} (status: ${response.status()})`);
      try {
        const text = await response.text();
        console.log(`[RESP BODY] ${url} => ${text.substring(0, 300)}`);
      } catch (e) {
        console.log(`[RESP BODY ERROR] ${url} => ${e.message}`);
      }
    }
  });

  console.log('Clicking Create/Generate button...');
  const generateBtn = page.locator('button:has-text("Create")').first();
  await generateBtn.click();

  console.log('Waiting 15 seconds to capture traffic...');
  await page.waitForTimeout(15000);

  console.log('Traffic inspection completed.');
  await browser.close();
}

main().catch(console.error);
