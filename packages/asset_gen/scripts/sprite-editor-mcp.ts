// Entry point: sprite editor MCP server on stdio.
// Register in .mcp.json (or drive from the A3 worker) with:
//   command: npm, args: [run, -s, sprite-mcp, --workspace=@dumrunner/asset_gen]

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startSpriteEditorMcp } from '../src/spriteEditor/mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
await startSpriteEditorMcp(join(here, '..', 'art', 'sprites'));
