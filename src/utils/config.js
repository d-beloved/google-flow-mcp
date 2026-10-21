import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let FLOW_HOME = path.resolve(__dirname, '..', '..');
if (!fs.existsSync(path.join(FLOW_HOME, 'config', 'flow.config.json'))) {
  const altHome = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(altHome, 'config', 'flow.config.json'))) {
    FLOW_HOME = altHome;
  }
}

const configPath = path.join(FLOW_HOME, 'config', 'flow.config.json');
let config;

try {
  const raw = fs.readFileSync(configPath, 'utf-8');
  config = JSON.parse(raw);
} catch (err) {
  console.error(`[CONFIG] Failed to load config from ${configPath}: ${err.message}`);
  config = {};
}

export default config;

export function get(key, fallback = undefined) {
  return config[key] !== undefined ? config[key] : fallback;
}

export function getFlowHome() {
  // Relative flowHome (e.g. ".") is resolved against the project root,
  // not process.cwd(). MCP clients often launch the server with cwd "/".
  return config.flowHome ? path.resolve(FLOW_HOME, config.flowHome) : FLOW_HOME;
}
