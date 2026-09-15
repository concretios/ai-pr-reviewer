import { sourceHash } from '../scripts/source-hash.js';

export async function sourceRevision(): Promise<string> {
  return `sha256:${await sourceHash()}`;
}
