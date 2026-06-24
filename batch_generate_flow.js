import fs from 'fs';
import path from 'path';
import os from 'os';
import { connectToBrowser, getPage } from './src/browser/connect.js';
import { handleGenerateImage } from './src/tools/generate-image.js';

const promptsPath = './prompts/prompts.txt';
const progressPath = path.join(os.homedir(), '.gemini', 'antigravity', 'brain', 'abd7b352-15c9-452e-a568-d9cba15816ee', 'scratch', 'batch_progress.json');
const downloadDir = path.join(os.homedir(), 'Downloads', 'google-flow-test');

// Helper to wait
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parsePrompts() {
  const content = fs.readFileSync(promptsPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const scenes = [];
  let currentScene = null;

  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('Scene_')) {
      if (currentScene) {
        scenes.push(currentScene);
      }
      currentScene = {
        id: line,
        prompt: '',
        settings: ''
      };
    } else if (line.startsWith('Prompt:')) {
      if (currentScene) {
        currentScene.prompt = line.substring(7).trim();
      }
    } else if (line.startsWith('Angle/settings:')) {
      if (currentScene) {
        currentScene.settings = line.substring(15).trim();
      }
    } else if (line === '') {
      // blank line
    } else {
      if (currentScene) {
        if (currentScene.settings) {
          currentScene.settings += ' ' + line;
        } else if (currentScene.prompt) {
          currentScene.prompt += ' ' + line;
        }
      }
    }
  }
  if (currentScene) {
    scenes.push(currentScene);
  }
  return scenes;
}

async function main() {
  // 1. Ensure directories exist
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
    console.log(`Created download folder: ${downloadDir}`);
  }

  // 2. Read existing progress
  let progress = {};
  if (fs.existsSync(progressPath)) {
    try {
      progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
      console.log(`Loaded existing progress. ${Object.keys(progress).length} scenes already completed.`);
    } catch (e) {
      console.warn('Could not parse progress file, starting fresh:', e.message);
    }
  }

  // 3. Parse all scenes
  const scenes = parsePrompts();
  console.log(`Parsed ${scenes.length} scenes from prompts.txt`);

  // 4. Connect to browser
  console.log('Connecting to existing browser session via CDP...');
  await connectToBrowser();
  const page = getPage();
  console.log(`Connected. Current page URL: ${page.url()}`);

  // Clear any existing title edit or focused state
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Clear prompt input box completely before starting
  const promptInput = page.locator('div[contenteditable="true"][role="textbox"]').first();
  if (await promptInput.isVisible().catch(() => false)) {
    await promptInput.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    console.log('Cleared initial prompt input box.');
    await page.waitForTimeout(500);
  }

  // 5. Iterate through scenes
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    if (progress[scene.id] && progress[scene.id].status === 'success') {
      console.log(`[${i + 1}/${scenes.length}] Skipping ${scene.id} (already completed).`);
      continue;
    }

    console.log(`\n==================================================`);
    console.log(`[${i + 1}/${scenes.length}] Starting generation for ${scene.id}...`);
    console.log(`Prompt: ${scene.prompt.substring(0, 120)}...`);

    let attempt = 0;
    let success = false;
    const maxAttempts = 3;

    while (attempt < maxAttempts && !success) {
      attempt++;
      try {
        console.log(`Attempt ${attempt}/${maxAttempts}...`);

        if (attempt > 1) {
          console.log('Reloading the page to reset Slate.js state on retry...');
          await page.reload({ waitUntil: 'networkidle' });
          await page.waitForTimeout(2000);
        }
        
        // Fills prompt and clicks Generate. skip_config=true honors user's manual settings
        const result = await handleGenerateImage({
          prompt: scene.prompt,
          auto_confirm: true,
          skip_config: true,
          model: 'Nano Banana 2',
          ratio: '16:9'
        });

        if (result && result.status === 'success') {
          console.log('Generation completed successfully. Starting download...');
          
          const uuid = result.image_uuids && result.image_uuids[0];
          if (!uuid) {
            throw new Error('No image UUID returned in generation result.');
          }

          console.log(`Locating image in grid with UUID: ${uuid}`);
          const imgSelector = `img[src*="${uuid}"]`;
          const imgLocator = page.locator(imgSelector).first();
          await imgLocator.waitFor({ state: 'visible', timeout: 15000 });
          await imgLocator.click();
          console.log('Clicked image to open detail modal.');

          // Wait for download button to stabilize/appear inside modal
          const downloadBtnLocator = page.locator('button:has-text("Download"), [aria-label*="download" i], [title*="Download" i]').first();
          await downloadBtnLocator.waitFor({ state: 'visible', timeout: 15000 });
          
          // Click download button to open dropdown
          await downloadBtnLocator.click();
          console.log('Clicked download icon. Waiting for "Original size" dropdown item...');

          // Wait for the dropdown item to appear
          const originalSizeLocator = page.getByText('Original size').first();
          await originalSizeLocator.waitFor({ state: 'visible', timeout: 5000 });

          // Set up download event listener
          const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
          await originalSizeLocator.click();
          
          const download = await downloadPromise;
          const suggestedName = download.suggestedFilename();
          const ext = path.extname(suggestedName) || '.png';
          const targetPath = path.join(downloadDir, `${scene.id}${ext}`);
          
          await download.saveAs(targetPath);
          console.log(`Saved downloaded image to: ${targetPath}`);

          // Close modal
          console.log('Closing download modal...');
          await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);

          success = true;
          progress[scene.id] = {
            status: 'success',
            id: scene.id,
            file: targetPath,
            timestamp: new Date().toISOString()
          };
          fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
        } else {
          throw new Error(result ? result.message : 'Unknown generation status');
        }
      } catch (err) {
        console.error(`Attempt ${attempt} failed:`, err.message);
        if (attempt < maxAttempts) {
          console.log('Waiting 10 seconds before retrying...');
          await delay(10000);
        }
      }
    }

    if (!success) {
      console.error(`❌ Failed to generate and download ${scene.id} after ${maxAttempts} attempts.`);
      progress[scene.id] = {
        status: 'failed',
        id: scene.id,
        timestamp: new Date().toISOString()
      };
      fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
    }

    // Wait a short throttle delay between prompts
    console.log('Throttling: waiting 5 seconds before next scene...');
    await delay(5000);
  }

  console.log('\n==================================================');
  console.log('BATCH IMAGE GENERATION PROCESS COMPLETED!');
  const successCount = Object.values(progress).filter(r => r.status === 'success').length;
  console.log(`Total scenes: ${scenes.length}, Successful: ${successCount}`);
}

main().catch(err => {
  console.error('Batch script crashed:', err);
  process.exit(1);
});
