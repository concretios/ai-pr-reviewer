import { z } from 'zod';
import { ProviderError, type Provider, type Request, type Generation } from './provider.js';
const usageSchema = z.object({ totalTokenCount: z.number().int().nonnegative().optional(), promptTokenCount: z.number().int().nonnegative().optional(),
  candidatesTokenCount: z.number().int().nonnegative().optional(), thoughtsTokenCount: z.number().int().nonnegative().optional(), cachedContentTokenCount: z.number().int().nonnegative().optional() });
const responseSchema = z.object({ usageMetadata: usageSchema.optional(), promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  candidates: z.array(z.object({ finishReason: z.string().optional(), content: z.object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })) }).optional() })).optional() });

// Keep provider diagnostics bounded and redact credentials before they reach reports.
async function errorDetail(response: Response, key: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) return '';
      chunks.push(value);
    }
    const envelope = z.object({ error: z.object({ status: z.string().optional(), message: z.string().optional() }) })
      .safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!envelope.success) return '';
    let detail = [envelope.data.error.status, envelope.data.error.message].filter(Boolean).join(': ');
    if (key) detail = detail.split(key).join('[REDACTED]');
    return detail.replace(/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED]').replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 1200);
  } catch { return ''; }
  finally { await reader.cancel().catch(() => {}); }
}
export class Gemini implements Provider {
  constructor(private readonly key: string, private readonly transport: typeof fetch = fetch) {}
  private async post(model: string, method: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(`https://generativelanguage.googleapis.com/v1beta/${model}:${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.key }, body: JSON.stringify(body), signal,
      });
    } catch { throw new ProviderError('Gemini transport failed or timed out; usage unknown', true); }
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const seconds = retry ? Number(retry) : 0;
      const retryAfter = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retry!) - Date.now());
      const detail = await errorDetail(response, this.key);
      throw new ProviderError(`Gemini ${method} HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status === 429 || response.status === 408 || response.status >= 500, Math.min(30000, retryAfter || 0));
    }
    try { return await response.json(); } catch { throw new ProviderError('Gemini returned an unreadable response envelope; usage unknown', false); }
  }
  async count(request: Request, signal: AbortSignal): Promise<number> {
    return this.countRaw(request.model, request, signal);
  }
  async countRaw(model: string, request: unknown, signal: AbortSignal): Promise<number> {
    const data = await this.post(model, 'countTokens', { generateContentRequest: request }, signal);
    return z.object({ totalTokens: z.number().int().nonnegative() }).parse(data).totalTokens;
  }
  async generateOnce(request: Request, signal: AbortSignal): Promise<Generation> {
    const { model, ...body } = request;
    return this.generateRawOnce(model, body, signal);
  }
  async generateRawOnce(model: string, body: unknown, signal: AbortSignal): Promise<Generation> {
    const raw = responseSchema.parse(await this.post(model, 'generateContent', body, signal));
    const candidate = raw.candidates?.[0];
    return { text: candidate?.content?.parts.filter(p => !p.thought).map(p => p.text ?? '').join('') ?? '',
      finishReason: raw.promptFeedback?.blockReason ? `BLOCKED:${raw.promptFeedback.blockReason}` : candidate?.finishReason ?? 'MISSING', usage: raw.usageMetadata };
  }
}
