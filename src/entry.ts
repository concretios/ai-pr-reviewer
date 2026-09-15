import { main } from './index.js';
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Finalization failed'); process.exitCode = 1; });
