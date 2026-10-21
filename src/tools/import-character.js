import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements, typeLikeHuman } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { handleCreateCharacter } from './create-character.js';

/**
 * Import a character from a saved JSON file (args.file_path).
 * Expected JSON shape:
 * {
 *   "name": "Character Name",
 *   "description": "Character description/prompt",
 *   "image_path": "/path/to/reference.png"        // or "reference_images": ["..."]
 * }
 * Image paths in the JSON may be absolute, or relative to the JSON file's directory.
 */
export async function handleImportCharacter(args) {
  const page = getPage();

  if (!args.file_path) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, 'file_path is required to import a character.');
  }
  if (!fs.existsSync(args.file_path)) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, `Character file not found: ${args.file_path}`);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(args.file_path, 'utf-8'));
  } catch (err) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, `Could not parse character JSON: ${err.message}`);
  }

  const jsonDir = path.dirname(path.resolve(args.file_path));
  const resolveImagePath = (p) => (path.isAbsolute(p) ? p : path.join(jsonDir, p));

  const characterName = data.name;
  const description = data.description;
  const referenceImages = Array.isArray(data.reference_images) && data.reference_images.length > 0
    ? data.reference_images.map(resolveImagePath)
    : (data.image_path ? [resolveImagePath(data.image_path)] : []);

  logger.info('Importing character from file', { name: characterName, file: args.file_path });

  // Same form as flow_create_character (/project/{id}/character).
  return handleCreateCharacter({
    name: characterName,
    description,
    reference_images: referenceImages,
    archetype: data.archetype,
    model: data.model,
    project_name: args.project_name,
    campaign: args.campaign,
    project_id: args.project_id,
    auto_confirm: args.auto_confirm === true,
  });
}
