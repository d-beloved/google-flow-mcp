#!/usr/bin/env node
// Single-process server (no hot reload). Use src/index.js normally.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, callTool } from './core.js';

const server = new Server({ name: 'google-flow-browser-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(req.params.name, req.params.arguments));
await server.connect(new StdioServerTransport());
