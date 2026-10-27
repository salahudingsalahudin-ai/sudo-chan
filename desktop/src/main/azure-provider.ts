import type { TtsProvider, TtsRequest, TtsResult } from '../shared/voice-interfaces.js';
import { normalizeForSpeech } from '../shared/speech.ts';
import {
  AZURE_OUTPUT_FORMAT, azureBackoffMs, azureEndpoint, buildAzureSsml, pickAzureVoice, validAzureRegion,
} from '../shared/azure-tts.ts';
import type { AzureRomanUrduRoute } from '../shared/azure-tts.ts';

type FetchFn = typeof fetch;

export interface AzureTtsOptions {
  getKey: () => string;
  getRegion: () => string;
  /** 'auto' or an AZURE_VOICES id. */
  getVoice: () => string | undefined;
  getRomanRoute: () => AzureRomanUrduRoute | undefined;
  fetchFn?: FetchFn;
}

/** Official Azure AI Speech text-to-speech REST API. The key only ever goes in a request header. */
export class AzureTtsProvider implements TtsProvider {
  readonly id = 'azure' as const;
  readonly name = 'Azure Speech';
  private options: AzureTtsOptions;
  private fetchFn: FetchFn;
  /** Characters sent in successful requests this session (Azure's free tier is about 500k per month). */
  charsUsed = 0;
  lastError = '';

  constructor(options: AzureTtsOptions) {
    this.options = options;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  hasKey(): boolean {
    return Boolean(this.options.getKey()) && validAzureRegion(this.options.getRegion());
  }

  private async post(key: string, region: string, ssml: string): Promise<Response> {
    return this.fetchFn(azureEndpoint(region), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': AZURE_OUTPUT_FORMAT,
        'User-Agent': 'Sudo-chan-Companion',
      },
      body: ssml,
      signal: AbortSignal.timeout(10_000),
    });
  }

  /** Voice this request would use (also part of the router's cache key). */
  voiceFor(req: TtsRequest): string {
    return pickAzureVoice(req.lang, this.options.getVoice(), this.options.getRomanRoute());
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const key = this.options.getKey();
    const region = this.options.getRegion();
    if (!key || !validAzureRegion(region)) return { ok: false, error: 'no-key' };
    const text = normalizeForSpeech(req.text);
    if (!text) return { ok: false, error: 'empty' };
    const voice = this.voiceFor(req);
    try {
      let res = await this.post(key, region, buildAzureSsml({ text, voice, emotion: req.emotion, speed: req.speed }));
      // A voice that rejects mstts:express-as answers 400; retry once with plain prosody.
      if (res.status === 400) res = await this.post(key, region, buildAzureSsml({ text, voice, emotion: req.emotion, speed: req.speed, useStyle: false }));
      if (!res.ok) {
        this.lastError = res.status === 401 || res.status === 403 ? 'Azure rejected the key or region.' : `Azure HTTP ${res.status}`;
        return { ok: false, error: `azure ${res.status}`, status: res.status, provider: 'azure', retryAfterMs: azureBackoffMs(res.status, res.headers.get('retry-after')) };
      }
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length < 200) {
        this.lastError = 'Azure returned no audio.';
        return { ok: false, error: 'azure returned no audio', retryAfterMs: azureBackoffMs(undefined) };
      }
      this.charsUsed += text.length;
      this.lastError = '';
      return { ok: true, dataUri: `data:audio/mp3;base64,${audio.toString('base64')}`, provider: 'azure', voice };
    } catch (error) {
      this.lastError = (error as Error).name === 'TimeoutError' ? 'Azure timed out.' : 'Could not reach Azure.';
      return { ok: false, error: this.lastError, retryAfterMs: azureBackoffMs(undefined) };
    }
  }
}
