// The build script embeds these files; tsx/Vitest read the same bytes locally.
import { readFileSync } from 'node:fs';
declare const __REVIEW_PROMPT__: string | undefined;
declare const __INTEGRATION_PROMPT__: string | undefined;
export const reviewPrompt = typeof __REVIEW_PROMPT__ === 'string' ? __REVIEW_PROMPT__ : readFileSync(new URL('../prompts/review.md', import.meta.url), 'utf8');
export const integrationPrompt = typeof __INTEGRATION_PROMPT__ === 'string' ? __INTEGRATION_PROMPT__ : readFileSync(new URL('../prompts/integration.md', import.meta.url), 'utf8');
