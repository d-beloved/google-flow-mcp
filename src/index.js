#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from './utils/logger.js';
import { launchKiaraProfile, navigateToFlow } from './browser/launch-profile.js';
import { getPage, getBrowser, setBrowser, closeBrowser as closeBrowserConnection } from './browser/connect.js';
import { verifyAccount as checkAccount } from './browser/account-check.js';
import { handleFlowOpen } from './tools/flow-open.js';
import { handleFlowStatus } from './tools/flow-status.js';
import { handleGenerateImage } from './tools/generate-image.js';
import { handleGenerateVideo } from './tools/generate-video.js';
import { handleDownloadLatest } from './tools/download-latest.js';
import { handleCreateCharacter } from './tools/create-character.js';
import { handleImportCharacter } from './tools/import-character.js';
import { handleOpenCharacters } from './tools/open-characters.js';
import { handleCreateScene } from './tools/create-scene.js';
import { handleOpenToolsGallery } from './tools/open-tools-gallery.js';
import { handleUseGridArchitect } from './tools/grid-architect.js';
import { handleDiscoverUi } from './tools/discover-ui.js';
import { handleListMentionOptions } from './tools/list-mentions.js';
import { handleUseFlowTool } from './tools/use-flow-tool.js';
import { jobQueue } from './queue/job-queue.js';
import { takeScreenshot } from './utils/screenshots.js';
import fs from 'fs';
import path from 'path';

const TOOL_DEFINITIONS = [
  {
    name: 'flow_connect',
    description: 'Launch Chrome with the configured Google profile, connect CDP, navigate to Google Flow, and verify account.',
    inputSchema: {
      type: 'object',
      properties: {
        headless: { type: 'boolean', description: 'Launch in headless mode (not recommended, Google Flow needs visible browser).', default: false },
        open_flow: { type: 'boolean', description: 'Auto-navigate to Google Flow after connection.', default: true },
      },
    },
  },
  {
    name: 'flow_disconnect',
    description: 'Close the browser and clean up the MCP connection to Google Flow.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_status',
    description: 'Check current connection status: browser connected, Flow page loaded, account verified, job queue state.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Return full status with screenshot.', default: false },
      },
    },
  },
  {
    name: 'flow_account_check',
    description: 'Verify the logged-in Google account matches the configured expected email (Default).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_discover_ui',
    description: 'Navigate to a Google Flow page and discover all interactive elements (buttons, inputs, links, headings). Updates the internal selectors map for robust automation.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Page to discover. Options: main, image-generation, video-generation, characters, scenes, images, all-media, tools-gallery, grid-architect. "characters" is project-scoped (/project/{id}/characters). "scenes"/"images"/"all-media" are sidebar tabs within the project (same URL). project_name/campaign target a specific project, or the current/active project is used.', default: 'main' },
        project_name: { type: 'string', description: 'Project name, used when page is "characters", "scenes", "images", or "all-media" (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching, used when page is "characters", "scenes", "images", or "all-media".' },
        url: { type: 'string', description: 'Exact URL to navigate to, overriding the page-based URL resolution.' },
      },
      required: ['page'],
    },
  },
  {
    name: 'flow_generate_image',
    description: '⚠️ CONSUMES CREDITS when auto_confirm=true. Default (auto_confirm=false): fills the prompt, sets model/ratio/count, screenshots, returns "ready_for_confirmation" — no credits. With auto_confirm=true: verifies Image mode + model, clicks Generate, waits for the new image(s), then downloads them (default 2K upscaled) to outputs/images.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The text prompt for image generation.' },
        model: { type: 'string', description: 'Nano Banana 2.1 (default), Nano Banana Pro, or Nano Banana 2 Lite. "Nano Banana 2" = 2.1.', default: 'Nano Banana 2.1' },
        auto_confirm: { type: 'boolean', description: '⚠️ CREDITS. false (default): prepare only. true: click Generate.', default: false },
        ratio: { type: 'string', description: 'Aspect ratio: 16:9, 4:3, 1:1, 3:4, 9:16.', default: '16:9' },
        quantity: { type: 'number', description: 'Images per run, 1–4 (each uses credits).', default: 1 },
        download: { type: 'string', description: 'After generating: "1K" (original), "2K" (upscaled, default), "4K" (upscaled; may need a higher plan), or "none".', default: '2K' },
        ingredients: { type: 'array', items: { type: 'string' }, description: 'Names of project assets to reference via "@name". Use flow_list_mention_options to see names.' },
        project_name: { type: 'string', description: 'Project to use, by exact name. Reuses the open project if its title matches, otherwise opens the existing project with that name, otherwise creates a new one with that name. Never renames an existing project.' },
        project_id: { type: 'string', description: 'Project ID (from flow_list_projects) — opens that project directly.' },
        new_project: { type: 'boolean', description: 'Always create a new project (named project_name if given).', default: false },
        campaign: { type: 'string', description: 'Campaign tag: reuses the project last used for this campaign.' },
        skip_config: { type: 'boolean', description: 'Do not touch model/ratio/count; use whatever is set in Flow.', default: false },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'flow_generate_video',
    description: '⚠️ CONSUMES CREDITS (video is expensive) when auto_confirm=true. Default: sets Video mode, model, ratio, duration, resolution, count and fills the prompt — no credits. With auto_confirm=true: clicks Generate and waits for the video(s).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The text prompt for video generation.' },
        model: { type: 'string', description: 'Veo 3.1 - Fast (default), Veo 3.1 - Quality, Veo 3.1 - Lite, or Omni 1.1 Flash. Shortcuts: fast, quality, lite, flash.', default: 'Veo 3.1 - Fast' },
        auto_confirm: { type: 'boolean', description: '⚠️ CREDITS. false (default): prepare only. true: click Generate.', default: false },
        ratio: { type: 'string', description: '16:9 or 9:16.', default: '16:9' },
        duration: { type: 'string', description: '4s, 6s, 8s or 10s, where the model offers a choice. Veo 3.1 - Lite is fixed (8s). Omit to keep the model setting.' },
        resolution: { type: 'string', description: '720p or 360p, where offered. Omit to keep the model setting.' },
        video_input: { type: 'string', description: '"Ingredients" (default) or "Frames".', default: 'Ingredients' },
        quantity: { type: 'number', description: 'Videos per run, 1–4.', default: 1 },
        download: { type: 'string', description: 'Optional: download each new video when done: "720p", "1080p" (upscaled) or "270p" (GIF). Omit to skip.' },
        ingredients: { type: 'array', items: { type: 'string' }, description: 'Names of project assets to reference via "@name".' },
        use_character: { type: 'string', description: 'Character name to reference via "@name".' },
        use_scene: { type: 'string', description: 'Scene name to reference via "@name".' },
        project_name: { type: 'string', description: 'Project to use, by exact name. Reuses the open project if its title matches, otherwise opens the existing project with that name, otherwise creates a new one with that name. Never renames an existing project.' },
        project_id: { type: 'string', description: 'Project ID (from flow_list_projects) — opens that project directly.' },
        new_project: { type: 'boolean', description: 'Always create a new project (named project_name if given).', default: false },
        campaign: { type: 'string', description: 'Campaign tag: reuses the project last used for this campaign.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'flow_download_latest',
    description: 'Download the newest image(s)/video(s) in a Flow project via the tile menu (Download ▸ size). Images: 1K original, 2K or 4K upscaled (upscaling takes ~10–20s). Saves to outputs/images or outputs/videos.',
    inputSchema: {
      type: 'object',
      properties: {
        size: { type: 'string', description: 'Images: "1K", "2K" (default) or "4K". Videos: "270p" (GIF), "720p" (default), "1080p" (upscaled) or "4K" (plan-gated).' },
        count: { type: 'number', description: 'How many of the newest items to download.', default: 1 },
        media_id: { type: 'string', description: 'Download this specific item (media id from a generate result).' },
        type: { type: 'string', description: '"image" or "video" — only consider that type.' },
        project_name: { type: 'string', description: 'Open this project (exact name) first.' },
        project_id: { type: 'string', description: 'Open this project ID first.' },
      },
    },
  },
  {
    name: 'flow_list_projects',
    description: 'List all projects on the Flow home page (name, id, url), newest first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_open_project',
    description: 'Open an existing Flow project by name (exact, case-insensitive; or a unique partial match) or by id. Later tool calls use this project.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name, e.g. "David Anthology (Goliath)".' },
        project_id: { type: 'string', description: 'Project ID instead of name.' },
      },
    },
  },
  {
    name: 'flow_create_character',
    description: 'Fill the Flow character form (/project/{id}/character) with a description. Default: prepare only, no credits. With auto_confirm=true: creates the character (credits) and renames it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Character name.' },
        description: { type: 'string', description: 'Character description/prompt.' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images for character design.' },
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
        auto_confirm: { type: 'boolean', description: '⚠️ CREDITS. false (default): fill the form only. true: click Start generation to create the character.', default: false },
        archetype: { type: 'string', description: 'Optional preset: The Eccentric, The Professional, The Wildcard, The Familiar, The Wicked, The Fantastical.' },
        model: { type: 'string', description: 'Optional model, e.g. Nano Banana 2.1.' },
        project_id: { type: 'string', description: 'Project ID.' },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'flow_import_character',
    description: 'Import a character from a saved JSON file into Google Flow.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to character JSON file.' },
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'flow_open_characters',
    description: 'Open the Characters page for the current/target project and list existing characters.',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
    },
  },
  {
    name: 'flow_list_mention_options',
    description: 'List the images and characters in the current project that can be referenced via "@name" in an image/video prompt (opens Flow\'s "@" reference popup and reads its options).',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
    },
  },
  {
    name: 'flow_create_scene',
    description: 'Create a new scene in Google Flow Scenes with characters and prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Scene description/prompt.' },
        characters: { type: 'array', items: { type: 'string' }, description: 'Character names to include in the scene.' },
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'flow_open_tools_gallery',
    description: 'Open the project Tools gallery and list tools in My tools, Templates and Community.',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Project (exact name) to open first.' },
        project_id: { type: 'string', description: 'Project ID to open first.' },
      },
    },
  },
  {
    name: 'flow_use_grid_architect',
    description: 'Open Grid Architect in Google Flow, fill theme prompt, shot prompts, engine, ratio, and visual logic settings. Supports batch shot generation for brand campaigns.',
    inputSchema: {
      type: 'object',
      properties: {
        theme_prompt: { type: 'string', description: 'Overall theme prompt for the grid.' },
        shot_prompts: { type: 'array', items: { type: 'string' }, description: 'Array of individual shot prompts for the grid.' },
        engine: { type: 'string', description: 'Engine/model for the grid.', default: 'Nano Banana 2' },
        ratio: { type: 'string', description: 'Aspect ratio for all shots.', default: '16:9' },
        visual_logic: { type: 'string', description: 'Visual logic type: None, Colour Pop, Side by Side, etc.' },
        references: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images.' },
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
      required: ['theme_prompt'],
    },
  },
  {
    name: 'flow_use_tool',
    description: 'Open any tool by name in Google Flow and optionally fill its configuration parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Tool card title, e.g. Grid Architect, Image Editor, Poster Designer, ThumbnailForge. See flow_open_tools_gallery.' },
        tab: { type: 'string', description: 'Optional: My tools, Templates or Community.' },
        project_id: { type: 'string', description: 'Project ID.' },
        params: { type: 'object', description: 'Optional configuration parameters for the tool.' },
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
      required: ['tool_name'],
    },
  },
  {
    name: 'flow_screenshot',
    description: 'Take a screenshot of the current Google Flow page.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Custom name for the screenshot file.', default: 'manual' },
      },
    },
  },
  {
    name: 'flow_queue_status',
    description: 'Check the job queue: active job, pending queue, completed and failed job history.',
    inputSchema: {
      type: 'object',
      properties: {
        history_limit: { type: 'number', description: 'Number of recent history entries to return.', default: 5 },
      },
    },
  },
  {
    name: 'flow_queue_reset',
    description: 'Forcefully reset the job queue. Use this if a job is permanently stuck in "running" state and blocking other generations.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleToolCall(name, args) {
  logger.info('Tool called', { tool: name, args: args ? JSON.stringify(args).substring(0, 200) : 'none' });

  switch (name) {
    case 'flow_connect': {
      const result = await launchKiaraProfile(args?.headless || false);
      if (result.browser) setBrowser(result.browser);
      const page = getPage();
      let oauthRequired = false;
      if (args?.open_flow !== false) {
        const navResult = await navigateToFlow(page);
        if (navResult && navResult.authenticated === false) {
          oauthRequired = true;
        }
      }
      const url = page.url();
      let accountCheck = null;
      try {
        accountCheck = await checkAccount(page);
      } catch (e) {
        accountCheck = { verified: false, error: e.message };
      }
      if (oauthRequired) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'oauth_required',
          message: 'Google Flow requires OAuth authentication. Open Chrome Default manually once:\n'
            + '  1. Launch: google-chrome --profile-directory="Default"\n'
            + '  2. Navigate to: https://flow.google.com → open a project → Tools → Templates → Grid Architect\n'
            + '  3. Complete the Google sign-in (one time)\n'
            + '  4. Retry this MCP tool in headless mode',
          browserType: 'Chrome Default',
          account: accountCheck?.account || 'verified-account',
          url: page.url().substring(0, 100),
          accountVerified: accountCheck,
        }, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'connected',
        browserType: 'Chrome Default',
        account: accountCheck?.account || 'verified-account',
        url: page.url(),
        accountVerified: accountCheck,
      }, null, 2) }] };
    }

    case 'flow_disconnect': {
      await closeBrowserConnection();
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'disconnected' }) }] };
    }

    case 'flow_status': {
      const status = await handleFlowStatus();
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    }

    case 'flow_account_check': {
      const page = getPage();
      const result = await checkAccount(page);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_discover_ui': {
      const result = await handleDiscoverUi(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_generate_image': {
      const result = await handleGenerateImage(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_generate_video': {
      const result = await handleGenerateVideo(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_list_projects': {
      const { listExistingProjects } = await import('./navigation/project-navigator.js');
      const projects = await listExistingProjects(getPage());
      return { content: [{ type: 'text', text: JSON.stringify({ count: projects.length, projects }, null, 2) }] };
    }

    case 'flow_open_project': {
      const nav = await import('./navigation/project-navigator.js');
      const result = args?.project_id
        ? await nav.ensureProjectInContext(getPage(), { project_id: args.project_id })
        : await nav.openProjectByName(getPage(), args?.name);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_download_latest': {
      const result = await handleDownloadLatest(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_create_character': {
      const result = await handleCreateCharacter(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_import_character': {
      const result = await handleImportCharacter(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_open_characters': {
      const result = await handleOpenCharacters(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_list_mention_options': {
      const result = await handleListMentionOptions(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_create_scene': {
      const result = await handleCreateScene(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_open_tools_gallery': {
      const result = await handleOpenToolsGallery(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_use_grid_architect': {
      const result = await handleUseGridArchitect(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_use_tool': {
      const result = await handleUseFlowTool(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_screenshot': {
      const { getPage } = await import('./browser/connect.js');
      const page = getPage();
      const ss = await takeScreenshot(page, args?.name || 'manual');
      return { content: [{ type: 'text', text: JSON.stringify({ screenshot: ss, message: 'Screenshot saved.' }) }] };
    }

    case 'flow_queue_status': {
      return { content: [{ type: 'text', text: JSON.stringify(jobQueue.getStatus(args?.history_limit), null, 2) }] };
    }

    case 'flow_queue_reset': {
      jobQueue.reset();
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', message: 'Job queue forcefully reset.' }) }] };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'google-flow-browser-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await handleToolCall(request.params.name, request.params.arguments);
  } catch (error) {
    logger.error('Tool execution error', { tool: request.params.name, error: error.message });
    if (error instanceof McpError) throw error;
    const message = error.message || 'Unknown error';
    const isBlocking = message.includes('MUST') || message.includes('cannot') || message.includes('blocked');
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: true,
        message,
        code: isBlocking ? 'BLOCKING' : 'ERROR',
        needsManualIntervention: isBlocking,
      }, null, 2) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
//logger.info('Google Flow Browser MCP server running on stdio');
