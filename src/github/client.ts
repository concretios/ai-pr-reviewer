import { bounded } from '../util.js';
export class GitHubError extends Error {
  constructor(message: string, readonly uncertain: boolean, readonly status?: number) { super(message); }
}
export interface GitHubAPI {
  get<T>(path: string): Promise<T>;
  list<T>(path: string): Promise<T[]>;
  write<T>(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<T>;
}
export class GitHub implements GitHubAPI {
  constructor(private readonly token: string, private readonly signal: AbortSignal, private readonly api = 'https://api.github.com', private readonly transport: typeof fetch = fetch) {}
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(15000)]);
    let response: Response;
    try {
      response = await bounded(this.transport(`${this.api}${path}`, { method, signal,
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: body === undefined ? undefined : JSON.stringify(body) }), signal);
    } catch { throw new GitHubError(`GitHub ${method} transport interrupted`, method !== 'GET'); }
    if (!response.ok) throw new GitHubError(`GitHub ${method} HTTP ${response.status}`, method !== 'GET' && response.status >= 500, response.status);
    try { return await bounded(response.json() as Promise<T>, signal); }
    catch { throw new GitHubError(`GitHub ${method} response could not be confirmed`, method !== 'GET'); }
  }
  get<T>(path: string): Promise<T> { return this.request<T>('GET', path); }
  write<T>(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<T> { return this.request<T>(method, path, body); }
  async list<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const items = await this.get<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new GitHubError('Invalid GitHub list response', false);
      all.push(...items);
      if (items.length < 100) return all;
    }
    throw new GitHubError('GitHub reconciliation list limit reached', false);
  }
}
