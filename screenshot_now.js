import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

async function main() {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();
    
    console.log('Current URL:', page.url());
    console.log('Current Title:', await page.title());
    
    const screenshotDir = './screenshots-debug';
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    
    const filepath = path.join(screenshotDir, 'current_sign_in_screen_2.png');
    await page.screenshot({ path: filepath });
    console.log('Screenshot saved to:', filepath);
    
    await browser.close();
  } catch (e) {
    console.error('CDP connection error:', e.message);
  }
}
main();
