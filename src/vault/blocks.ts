import { normalizePath } from 'obsidian';
import {
  parseDeleteBlocks as parseDeleteBlocksCore,
  parseEditBlocks as parseEditBlocksCore,
} from '../core';
import type { DeleteBlock, EditBlock } from '../core';

// The parsers live in src/core.ts so they can be unit tested without Obsidian;
// these wrappers bind the app's normalizePath.
export const parseEditBlocks   = (t: string): EditBlock[]   => parseEditBlocksCore(t, normalizePath);
export const parseDeleteBlocks = (t: string): DeleteBlock[] => parseDeleteBlocksCore(t, normalizePath);
