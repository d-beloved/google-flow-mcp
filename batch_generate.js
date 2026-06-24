import fs from 'fs';
import path from 'path';
import { launchChromeDirect, closeBrowser } from './src/browser/connect.js';
import { handleGenerateImage } from './src/tools/generate-image.js';

const scenesJsonPath = 'C:\\Users\\user\\.gemini\\antigravity\\brain\\9bb290bc-d914-4747-b2f2-b05be0ddcf6c\\scratch\\scenes.json';
const resultsJsonPath = 'C:\\Users\\user\\.gemini\\antigravity\\brain\\9bb290bc-d914-4747-b2f2-b05be0ddcf6c\\scratch\\batch_results.json';

async function main() {
  if (!fs.existsSync(scenesJsonPath)) {
    console.error('Scenes JSON file not found at:', scenesJsonPath);
    process.exit(1);
  }
  const scenes = JSON.parse(fs.readFileSync(scenesJsonPath, 'utf-8'));
  console.log(`Loaded ${scenes.length} scenes from JSON.`);

  let results = {};
  if (fs.existsSync(resultsJsonPath)) {
    results = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf-8'));
    console.log(`Loaded existing progress. ${Object.keys(results).length} scenes already in results.`);
  }

  console.log('Launching Chrome with KiaraFlow profile...');
  const { page } = await launchChromeDirect({
    headless: false
  });

  try {
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (results[scene.id] && results[scene.id].status === 'success') {
        console.log(`[${i+1}/${scenes.length}] Skipping ${scene.id} (already completed).`);
        continue;
      }

      console.log(`\n==================================================`);
      console.log(`[${i+1}/${scenes.length}] Starting generation for ${scene.id}...`);
      console.log(`Prompt: ${scene.prompt.substring(0, 100)}...`);

      let attempt = 0;
      let success = false;
      let result = null;

      while (attempt < 3 && !success) {
        attempt++;
        try {
          console.log(`Attempt ${attempt}/3...`);
          result = await handleGenerateImage({
            prompt: scene.prompt,
            auto_confirm: true,
            model: 'Nano Banana 2',
            ratio: '16:9',
            project_name: 'Creative Campaign Project',
            campaign: 'creative-campaign'
          });

          if (result && result.status === 'success') {
            success = true;
            console.log(`Successfully generated ${scene.id}!`);
            console.log(`URLs:`, result.image_urls);
            results[scene.id] = {
              status: 'success',
              id: scene.id,
              urls: result.image_urls,
              uuids: result.image_uuids,
              project_url: result.project_url,
              timestamp: new Date().toISOString()
            };
            fs.writeFileSync(resultsJsonPath, JSON.stringify(results, null, 2));
          } else {
            console.warn(`Attempt ${attempt} returned status: ${result ? result.status : 'null'}`);
          }
        } catch (e) {
          console.error(`Attempt ${attempt} failed with error:`, e.message);
          if (attempt < 3) {
            console.log('Waiting 10 seconds before retrying...');
            await new Promise(r => setTimeout(r, 10000));
          }
        }
      }

      if (!success) {
        console.error(`Failed to generate ${scene.id} after 3 attempts.`);
        results[scene.id] = {
          status: 'failed',
          id: scene.id,
          error: result ? result.message : 'Unknown error',
          timestamp: new Date().toISOString()
        };
        fs.writeFileSync(resultsJsonPath, JSON.stringify(results, null, 2));
      }

      console.log('Throttling: waiting 5 seconds...');
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log('\n==================================================');
    console.log('BATCH IMAGE GENERATION PROCESS COMPLETED!');
    const successCount = Object.values(results).filter(r => r.status === 'success').length;
    console.log(`Total scenes: ${scenes.length}, Successful: ${successCount}`);
  } catch (e) {
    console.error('Batch loop crashed with error:', e);
  } finally {
    console.log('Closing browser connections...');
    await closeBrowser();
    console.log('Done.');
    process.exit(0);
  }
}

main();
