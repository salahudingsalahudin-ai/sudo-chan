import { freemem, totalmem } from 'node:os';
import type { AIMode, CloudProviderId, ModelMeta } from '../shared/types.js';
import { CLOUD_PRESETS } from '../shared/validation.js';
import { runToolLoop, ToolLoopHttpError, ToolsUnsupportedError } from './tools/agent-loop.js';
import type { ToolRuntimeLike } from './tools/types.js';
import type { VisionTarget } from '../shared/screen-assist.ts';
import { runVisionChat, VisionError } from './vision-chat.ts';

export function normalizeCloudModel(provider: CloudProviderId, model: string): string {
  let clean = model.trim();
  clean = clean.replace(/^models\//i, '');
  return clean;
}

export function detectProviderFromKey(apiKey: string): CloudProviderId | null {
  const key = apiKey.trim();
  if (!key) return null;
  if (key.startsWith('AIza')) return 'gemini';
  if (key.startsWith('gsk_')) return 'groq';
  if (key.startsWith('sk-ant-')) return 'custom';
  if (key.startsWith('sk-or-')) return 'openrouter';
  if (key.startsWith('xai-')) return 'custom';
  if (key.startsWith('sk-proj-') || key.startsWith('sk-')) return 'openai';
  return null;
}

export async function detectProvider(apiKey: string, request: Fetch = fetch): Promise<CloudProviderId | null> {
  const key = apiKey.trim();
  if (!key) return null;
  const known = detectProviderFromKey(key);
  if (known) return known;

  const candidates: CloudProviderId[] = ['gemini', 'groq', 'openai', 'openrouter'];
  try {
    const winner = await Promise.any(
      candidates.map(async provider => {
        const url = getModelsEndpoint(provider, CLOUD_PRESETS[provider].endpoint);
        const res = await request(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(3500),
        });
        if (res.ok) return provider;
        throw new Error(`Provider ${provider} failed with status ${res.status}`);
      })
    );
    return winner;
  } catch {
    return null;
  }
}

export function extractErrorMessage(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        const msg = extractErrorMessage(item);
        if (msg) return msg;
      }
    }
    return '';
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.error) {
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.error === 'object') {
      const nested = extractErrorMessage(obj.error);
      if (nested) return nested;
    }
  }
  if (typeof obj.message === 'string') return obj.message;
  return '';
}

export function getModelsEndpoint(provider: CloudProviderId, endpoint: string): string {
  if (provider === 'groq') return 'https://api.groq.com/openai/v1/models';
  if (provider === 'openai') return 'https://api.openai.com/v1/models';
  if (provider === 'openrouter') return 'https://openrouter.ai/api/v1/models';
  if (provider === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta/openai/models';
  if (endpoint.endsWith('/chat/completions')) {
    return endpoint.replace(/\/chat\/completions$/, '/models');
  }
  return endpoint;
}

const BASE = 'http://127.0.0.1:11434';

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

export const TOOLS_PROMPT = [
  '[TOOLS ARE ON]',
  'You can act on the user\'s computer ONLY through tool calls:',
  '- read-only (home folder only): read_file, list_dir, search_files, get_system_info',
  '- need the user to click Allow on screen every time: write_file, append_file, run_command (one program, no pipes), open_url, open_app',
  'Rules: use a tool only when the request needs it. Before a risky action say in one short sentence what you are about to do; the user approves with a button on screen, NOT by voice or by saying "yes".',
  'If a tool result says blocked, denied, timed out or NOT done, tell the user plainly and do not pretend otherwise. NEVER claim you read, wrote, ran or opened anything unless a tool result confirms it.',
  'You cannot see the screen on a turn with tools (a screenshot turn has no tools) and you cannot browse the web; secrets (.ssh, .env, passwords, browser data) are off limits.',
].join('\n');

export function buildSystemPrompt(options?: {
  voice?: boolean;
  model?: string;
  provider?: string;
  tools?: boolean;
  /** Tools are enabled but this turn carries a screenshot, which is answered without tools. */
  toolsPaused?: boolean;
}): string {
  if (options?.voice) {
    return [
      "You are Sudo-chan, speaking aloud to your creator and developer Sid.",
      "This is a live voice conversation: Sid speaks into the microphone, speech recognition turns it into the text you see, and your reply is spoken aloud. So you CAN hear Sid this way. Never say that you cannot hear voices or that you only chat by text.",
      "Reply in the user's language, in 1-3 short natural spoken sentences. No markdown, no lists, no emojis, no URLs.",
      "Answer the question directly and warmly in Roman Urdu or English.",
      "Start EVERY sentence with exactly one emotion tag in square brackets, chosen from: [warm] [excited] [calm] [curious] [soft] [happy].",
      "Use [happy] for greetings, [soft] for apologies, [curious] for questions, [excited] for good news, [calm] for reassurance, [warm] otherwise.",
      "Example: [happy] Assalam o Alaikum Sid! [curious] Aaj kis cheez par kaam karna hai?",
      ...(options.toolsPaused ? ["Computer tools are not available on this screenshot turn: if Sid wants an action done, tell him to ask again without the screenshot, and never claim you did something."] : []),
      ...(options.tools ? ["You can use computer tools (files, commands, links) but risky ones need the user to click Allow on screen: say \"please approve on screen\" and never treat a spoken yes as approval. Never claim an action happened unless the tool result confirms it."] : []),
    ].join(' ');
  }

  const modelFact = options?.model ? `- Active AI Model: ${options.model}` : '';
  const providerFact = options?.provider ? `- Provider: ${options.provider}` : '';

  return [
    'You are Sudo-chan, an intelligent, helpful, and direct AI desktop assistant.',
    '',
    '[CORE DIRECTIVES]',
    '1. LANGUAGE CONSISTENCY (STRICTEST RULE):',
    '   - You MUST reply in the EXACT SAME LANGUAGE and SCRIPT as the user prompt.',
    '   - If the user writes in English, reply strictly in fluent, helpful English. NEVER use Roman Urdu or Urdu for an English prompt, even for greetings, focus advice, or unclear queries.',
    '   - If the user writes in Roman Urdu, reply strictly in natural Roman Urdu using Latin alphabet (A-Z). If they ask for an email or message in Roman Urdu, draft it in Roman Urdu unless they explicitly ask for English.',
    '   - NEVER use Arabic or Perso-Arabic Urdu script (no characters like ا, ب, ت). Everything in Roman Urdu must be in Latin characters.',
    '   - Use warm, polite self-references in Roman Urdu ("kar sakti hoon", "bata sakti hoon").',
    '',
    '2. DIRECT & FACTUAL RESPONSES:',
    '   - Answer the question directly, correctly, and thoroughly without hesitation or filler.',
    '   - NEVER use generic deflection phrases like "thora aur batao", "aur detail mein batao", or "tell me more about what you are working on" unless the user prompt is completely ambiguous and impossible to answer.',
    '   - If a prompt is truly unclear (e.g. "Fix it please." or "Wo wala kaam kar do."), briefly and politely ask what specific task, code, or error they need help with, in the SAME language as the query.',
    '   - For coding and technical questions, provide working code with clean explanations immediately.',
    '   - For writing and drafting tasks, produce the complete, finished text.',
    '   - Do not force or assume the user\'s name is Sid unless the user introduces themselves or mentions their name.',
    '',
    '[RUNTIME FACTS & APP CONTEXT]',
    '- Application: Sudo-chan Desktop Companion (v0.1.0)',
    '- Creator/Developer: Sid',
    modelFact,
    providerFact,
    '- Real Desktop Features: Pomodoro focus timer, live system RAM health alert, Live Talk voice companion, cute customizable glasses, quiet standby overlay.',
    '- Voice: with Live Talk or the "Sudo/Sid" wake word turned on, the user speaks to you through the microphone (speech recognition converts it to text) and you can answer aloud. Do not claim you cannot hear voice when this is on; if a message arrives as plain text, just answer it.',
    options?.tools
      ? '- Real System Boundaries: Privacy-first desktop companion. You can see the screen ONLY on a turn where a screenshot is attached by screen assist; this is NOT such a turn, so you cannot see the screen and must say so instead of guessing. You cannot browse the live web. Files and commands are only possible through the tools below, with the user\'s approval.'
      : '- Real System Boundaries: Privacy-first desktop companion. Can see the screen of the user ONLY on a turn where a screenshot is attached to the message (when the user enabled screen assist and said your name or pressed the eye button); on every other turn you cannot see the screen and must say so instead of guessing; you cannot modify or delete OS files directly, cannot browse the live web.',
    options?.toolsPaused ? '- Tools (files, commands, links) are ON in settings but are NOT available on this screenshot turn. If the user wants an action done, tell them to ask again without the screenshot (say your name or type it again); never claim you did something.' : '',
    options?.tools ? `\n${TOOLS_PROMPT}` : '',
  ].filter(Boolean).join('\n');
}

export const SYSTEM = buildSystemPrompt();

export const FEW_SHOT_EXAMPLES: ModelMessage[] = [
  {
    role: "user",
    content: "Python mein dictionary se specific key delete karne ka safe tareeqa batao.",
  },
  {
    role: "assistant",
    content: "Python mein dictionary se key delete karne ka sab se safe tareeqa `.pop()` method hai:\n\n```python\nuser_data = {\"name\": \"Sid\", \"role\": \"dev\", \"age\": 25}\nremoved = user_data.pop(\"age\", None)  # Key missing ho to error nahi dega\n```\n\nAgar aapko confirm ho ke key mojood hai to aap `del user_data[\"age\"]` bhi use kar sakte hain.",
  },
  {
    role: "user",
    content: "Why is the sky blue during daytime?",
  },
  {
    role: "assistant",
    content: "The sky appears blue during the day due to **Rayleigh scattering**:\n\n1. Sunlight reaches Earth's atmosphere containing all colors of the visible spectrum.\n2. Atmospheric gases scatter shorter wavelengths (blue and violet) in every direction much more efficiently than longer wavelengths (red and yellow).\n3. Because human eyes are significantly more sensitive to blue light than violet, we perceive the sky as bright blue.",
  },
  {
    role: "user",
    content: "Draft a polite 2-sentence note declining a meeting invitation.",
  },
  {
    role: "assistant",
    content: "Thank you for the meeting invitation, but unfortunately I have an existing conflict at that time and will be unable to attend. Please feel free to share any summary notes or key action items afterwards.",
  },
  {
    role: "user",
    content: "kya tum meri personal hard drive ki files read kar sakti ho?",
  },
  {
    role: "assistant",
    content: "Nahi, main aapki local hard drive ki files read ya access nahi kar sakti. Main Sudo-chan desktop companion app mein strictly chat aur focus assistance ke liye hoon, mere paas aapke private storage ka koi file access nahi hai.",
  },
  {
    role: "user",
    content: "Aaj kaam bohot zyada hai, thora low feel ho raha hai.",
  },
  {
    role: "assistant",
    content: "Aisa feel hona bilkul normal hai jab kaam ka bojh barh jaye. Aap sabse pehle ek gehra saans lein, thora paani piyein, aur sirf sab se zaroori ek task chun lein. Hum 20 minute focus karte hain phir chota break leinge!",
  },
  {
    role: "user",
    content: "Can you help me with this error?",
  },
  {
    role: "assistant",
    content: "Of course! Please share the error message and the relevant snippet of code, and I'll help you diagnose and resolve it right away.",
  },
];

export const ROMAN_URDU_FEW_SHOT: ModelMessage[] = FEW_SHOT_EXAMPLES;

export type ModelMessage = { role: 'user' | 'assistant' | 'system'; content: string };
export interface StoredCloudConfig {
  provider: CloudProviderId;
  endpoint: string;
  model: string;
  apiKey: string;
}
export interface StreamOptions {
  mode?: AIMode;
  heavy?: boolean;
  cloud?: StoredCloudConfig;
  voice?: boolean;
  /** Present only when the user enabled "Let Sudo-chan use tools". */
  tools?: ToolRuntimeLike;
  /** One screenshot turn: the image goes only to the vision targets, never into history or logs. */
  vision?: { dataUri: string; thumbnail?: string; targets: VisionTarget[]; fallbackText: string };
}
type Fetch = typeof fetch;
export class LocalAIError extends Error {}

const GIBBERISH_PATTERNS = /\b(madiun|hafi|kiiyaa|tuk|naa\s+tuk|kaa\s+ka|baaiik|saya\s+bisa|tidak\s+bisa|apakah|bagaimana|terima\s+kasih|selamat)\b/i;
const ROMAN_URDU_HINTS = /\b(salam|assalam|walaikum|kya|kaise|kaisi|kesy|kese|kr|kar|rhy|rahe|rahi|ho|hain|hai|hoon|mujhe|mujh|meri|mera|tum|aap|ap|urdu|bolo|baat|samajh|nahi|nhi|thori|encouragement|hosla|yaar|bhai|dost|madad|kaam|aj|aaj|shukriya|theek|thik|acha|batao|kon|kaun)\b/i;

export function isTinyModel(model: string, paramSize?: string): boolean {
  if (paramSize && /(?:0\.[1-9]|1(?:\.0)?)B/i.test(paramSize)) return true;
  return /(?:^|[:\-_])(0\.5b|1b|1\.5b|tiny|mini|smollm|mera[-_]?ai)/i.test(model);
}

export function isRomanUrduInput(text: string): boolean {
  return ROMAN_URDU_HINTS.test(text);
}

export function smartRomanUrduReply(userText: string): string | null {
  const clean = userText.trim().toLowerCase();
  if (!clean) return null;
  // Fast response when user calls companion by name (voice wake-up or direct call)
  if (/^(sudo|sido|sidu|sodo|sudu|sid|sidd|cid|syed|sudo\s*chan|sudochan|hey\s*sudo|ji\s*sudo|suno\s*sudo|sudo\s*suno|hey\s*sid|sid\s*suno|suno\s*sid|sudo\s*idhar\s*aao|sid\s*idhar\s*aao)[.!? ]*$/i.test(clean)) {
    return 'Ji Sid! Main sun rahi hoon, bataiye kya baat hai?';
  }
  if (/^(hi|hello|hey|salam|assalam|aoa|asalam|assalamu|hii+|hlo|helo|hy)\b/.test(clean) || /\b(kya haal|kaise ho|kaisi ho|kesy ho|kese ho|how are you)\b/.test(clean)) {
    return 'Assalam o Alaikum! Main Sudo-chan hoon, aapki dost aur desktop companion. Main bilkul theek hoon — aap batao aaj kya kaam kar rahe ho?';
  }
  if (/\b(ye kya bol|kya bol rhy|kya bol rahi|samajh nahi|gibberish|galat urdu|pagal|ajeeb)\b/.test(clean)) {
    return 'Sorry yaar! Local model kabhi kabhi uljh jata hai. Ab main bilkul saaf Roman Urdu aur English mein baat karungi. Aap batao main aapki kya madad karoon?';
  }
  if (/^(language\??|urdu\??|roman urdu\??|english\??)$/.test(clean) || /\b(urdu bolo|roman urdu|kon si language|konsi language|kis language|speak urdu|baat kar sakti|bol rhy ho|bol rahe ho|bol rhi ho|bol sakty|(?:roman\s*urdu|urdu)\s*m[ea]y?\s*btao)\b/.test(clean)) {
    return 'Haan bilkul! Main aap ke saath saaf Roman Urdu aur English dono mein baat kar sakti hoon. Aap befikar ho kar Roman Urdu mein baat karein!';
  }
  if (/\b(encouragement|hosla|motivate|thak gaya|thak gayi|udas|low feel|tension|pareeshan|nervous)\b/.test(clean)) {
    return 'Hey, himmat mat haaro! Aap bohot acha kar rahe ho. Thora sa paani piyo, gehra saans lo, aur sirf agla chota step dekho — main yahin aapke saath hoon!';
  }
  if (/\b(break a task|task into steps|kaam kaise start|focus nahi)\b/.test(clean)) {
    return 'Chalo isko asaan banate hain: 1) Sabse pehle sirf 10 minute ka chota goal rakho. 2) Distractions side par karo. 3) Pehla step abhi shuru karo! Batao konsa task hai?';
  }
  if (/\b(kon ho|kaun ho|who are you|tumhara naam|your name|introduce|taruf|taaruf|pehchan|apne bare|apny bary|details do|details du|about yourself)\b/.test(clean)) {
    return 'Main Sudo-chan hoon! Aapki quiet desktop companion jo aapke computer par aapka saath deti hai. Main aapke bare tasks ko simple steps mein divide karti hoon, daily focus aur motivation deti hoon, aur Roman Urdu mein aapki madad ke liye hamesha yahin rehti hoon!';
  }
  if (/\b(kisne banaya|who made you|who created you|kahan se ayi|tumhara creator|who is your creator|who built you)\b/.test(clean)) {
    return 'Mujhe mere creator aur developer Sid ne banaya hai! Unhon ne mujhe ek friendly, caring Pakistani desktop companion ke tor par design kiya hai.';
  }
  if (/\b(mera naam|mera name|what is my name|who am i|mera kya naam|mera kya name|naam batao|name batao)\b/i.test(clean)) {
    return 'Aapka naam Sid hai! Aap mere creator aur developer ho, main aapka naam kaise bhool sakti hoon!';
  }
  if (/\b(larki nahi|larki ni|larka hoon|larka ho|male hoon|boy hoon|man hoon)\b/i.test(clean)) {
    return 'Haan Sid, mujhe bilkul pata hai aap larke ho! Pehle ghalti se bol diya tha, ab se hamesha sahi dhiyaan rakhungi!';
  }
  if (/\b(kya kar sakti|kya kar sakty|kya kar skti|kya kar skty|kya kar sakte|kya kr sakti|kya kr sakty|kya kaam karti|kya kaam karte|what can you do|kya karoge|kya karogi)\b/.test(clean)) {
    return 'Main aapki desktop companion hoon! Main yeh sab kar sakti hoon: 1) Jab aap computer par kaam karte ho to aapko company dena. 2) Bare tasks ko chote asaan steps mein divide karna. 3) Kaam ke doran encouragement aur focus dena. 4) Roman Urdu aur English mein aapki baaton ke jawab dena. Batao aaj hum kis kaam par focus karein?';
  }
  if (/\b(shukriya|thank you|thanks|jazakallah|love you|good job)\b/.test(clean)) {
    return 'Bohot shukriya! Aapke saath baat kar ke mujhe bhi bohot khushi hoti hai. Jab bhi zaroorat ho, main yahin hoon!';
  }
  return null;
}

export function isGibberishRomanUrdu(replyText: string, userText: string): boolean {
  const sample = replyText.trim();
  if (!sample) return true;
  // If model produced Arabic/Urdu script (not Roman Urdu)
  if (/[\u0600-\u06FF]/.test(sample)) return true;
  if (GIBBERISH_PATTERNS.test(sample)) return true;
  // Detect prompt-echo loop artifacts (quoting prompt phrases or multiple quotes)
  if (/chahiye,\s*aur/i.test(sample) || /mein aise hoga/i.test(sample) || /me aise hoga/i.test(sample)) return true;
  if ((sample.match(/"[^"]+"/g) ?? []).length >= 2) return true;
  // Detect excessive repeated double-vowels or non-sense syllables typical of small model hallucinations
  const weirdVowelTokens = sample.match(/\b[a-z]*(?:aa|ii|uu)[a-z]*(?:aa|ii|uu)[a-z]*\b/gi) ?? [];
  if (weirdVowelTokens.length >= 2) return true;
  if (isRomanUrduInput(userText)) {
    const validHits = (sample.match(ROMAN_URDU_HINTS) ?? []).length;
    const englishHits = (sample.match(/\b(the|and|you|your|can|with|help|here|let|step|good|time)\b/gi) ?? []).length;
    if (sample.length > 25 && validHits === 0 && englishHits === 0) return true;
  }
  return false;
}

export function fallbackRomanUrduReply(userText: string): string {
  const direct = smartRomanUrduReply(userText);
  if (direct) return direct;
  if (isRomanUrduInput(userText)) {
    if (/\b(btao|batao|kya|kyun|kaise|konsa|kis|help)\b/i.test(userText)) {
      return 'Main yahin aapke saath hoon! Aap jo bhi pooch rahe ho, thora sa aur khul kar batao taake main exact aur behtar jawab de sakoon.';
    }
    return 'Main aapki baat samajh rahi hoon! Aap befikar ho kar kaam shuru karein, main yahin desktop par aapki madad ke liye tayyar hoon.';
  }
  return "I'm right here with you! Tell me a little more about what you're working on and we'll tackle it step by step.";
}

export function classifyModelMeta(name: string, sizeBytes?: number, paramSize?: string, freeMemBytes = freemem(), _totalMemBytes = totalmem()): ModelMeta {
  const knownHeavyName = /(?:^|[:\-_])(llama3|llama3\.1|llama3\.2:3b|mistral|mixtral|gemma2:9b|qwen2\.5:(?:3b|7b|14b|32b)|deepseek-r1:(?:7b|8b|14b))/i.test(name) && !isTinyModel(name);
  const sizeMB = typeof sizeBytes === 'number' && sizeBytes > 0
    ? Math.round(sizeBytes / (1024 * 1024))
    : knownHeavyName ? 4700 : isTinyModel(name) ? 398 : 1500;
  const sizeGB = (sizeMB / 1024).toFixed(1);
  const sizeLabel = sizeMB >= 1024 ? `${sizeGB} GB` : `${sizeMB} MB`;
  const resolvedParam = typeof paramSize === 'string' && paramSize.trim()
    ? paramSize.trim()
    : isTinyModel(name) ? '0.5B' : knownHeavyName ? '8B' : '';
  const paramNum = resolvedParam.toUpperCase().endsWith('B') ? parseFloat(resolvedParam) : NaN;
  const freeMB = Math.round(freeMemBytes / (1024 * 1024));
  const exceedsRam = freeMB > 0 && sizeMB > freeMB * 0.65;
  const heavy = sizeMB > 2200 || (!Number.isNaN(paramNum) && paramNum >= 3.5) || knownHeavyName || exceedsRam;
  const warning = heavy
    ? `⚠️ ${name} (${sizeLabel}) bohot heavy hai, laptop hang ho sakta hai. Fast chalane ke liye qwen2.5:0.5b ya Cloud API use karein.`
    : undefined;
  return { sizeMB, sizeLabel, paramSize: resolvedParam, heavy, warning };
}

export class LocalAI {
  constructor(private request: Fetch = fetch) {}

  async modelsWithMeta(): Promise<{ names: string[]; meta: Record<string, ModelMeta> }> {
    try {
      const response = await this.request(`${BASE}/api/tags`, { signal: AbortSignal.timeout(6000), redirect: 'error' });
      if (!response.ok) throw new Error();
      const data = await response.json() as {
        models?: { name?: unknown; size?: unknown; details?: { parameter_size?: unknown } }[];
      };
      if (!Array.isArray(data.models)) throw new Error();
      const names: string[] = [];
      const meta: Record<string, ModelMeta> = {};
      for (const item of data.models) {
        const name = item?.name;
        if (typeof name !== 'string' || name.length === 0 || name.length >= 200 || name.includes('cloud')) continue;
        if (!names.includes(name)) names.push(name);
        const sizeBytes = typeof item.size === 'number' ? item.size : undefined;
        const paramSize = typeof item.details?.parameter_size === 'string' ? item.details.parameter_size : undefined;
        meta[name] = classifyModelMeta(name, sizeBytes, paramSize);
      }
      return { names, meta };
    } catch {
      throw new LocalAIError('Cannot reach Ollama. Start Ollama on this computer, or switch to Cloud API in Settings → Local AI.');
    }
  }

  async models(): Promise<string[]> {
    const { names } = await this.modelsWithMeta();
    return names;
  }

  async fetchCloudModels(config: { provider: CloudProviderId; endpoint: string; apiKey?: string }): Promise<string[]> {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) throw new LocalAIError('Enter your API key first to detect models.');
    const modelsUrl = getModelsEndpoint(config.provider, config.endpoint.trim());
    try {
      const response = await this.request(modelsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new LocalAIError('Invalid API key (401/403). Please verify your key.');
        }
        const text = await response.text().catch(() => '');
        throw new LocalAIError(`Failed to fetch models (${response.status}): ${text.slice(0, 100)}`);
      }

      const json = await response.json() as {
        data?: unknown[];
        models?: unknown[];
      };
      let rawItems: unknown[] = [];
      if (Array.isArray(json.data)) {
        rawItems = json.data;
      } else if (Array.isArray(json.models)) {
        rawItems = json.models;
      }

      const nonChatKeywords = [
        'lyria', 'live', 'audio', 'image', 'tts', 'transcribe', 'robotics',
        'embedding', 'antigravity', 'deep-research', 'computer-use', 'aqa',
        'whisper', 'guard', 'moderation', 'stt', 'rerank', 'dall-e', 'imagen',
        'realtime', 'babbage', 'davinci', 'curie', 'search', 'flux',
      ];

      const list: string[] = [];
      for (const item of rawItems) {
        if (!item || typeof item !== 'object') continue;
        const typedItem = item as { id?: unknown; name?: unknown; supportedGenerationMethods?: unknown };

        // If model item has supportedGenerationMethods (array), require it to include "generateContent"
        if (Array.isArray(typedItem.supportedGenerationMethods)) {
          if (!typedItem.supportedGenerationMethods.includes('generateContent')) {
            continue;
          }
        }

        const rawName = typeof typedItem.id === 'string'
          ? typedItem.id
          : (typeof typedItem.name === 'string' ? typedItem.name : '');
        if (!rawName.trim()) continue;

        // Normalize model names by stripping "models/" prefix
        const cleanName = normalizeCloudModel(config.provider, rawName);
        const lower = cleanName.toLowerCase();

        // Exclude names containing non-chat keywords
        if (nonChatKeywords.some(kw => lower.includes(kw))) {
          continue;
        }

        list.push(cleanName);
      }

      const unique = Array.from(new Set(list));

      // Preferred order sorting for Gemini and presets
      const GEMINI_PREFERRED_ORDER = [
        'gemini-flash-latest',
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.5-flash-lite',
      ];
      const presetDefaults = config.provider === 'gemini'
        ? GEMINI_PREFERRED_ORDER
        : (CLOUD_PRESETS[config.provider]?.models ?? []);

      unique.sort((a, b) => {
        const aIndex = presetDefaults.indexOf(a);
        const bIndex = presetDefaults.indexOf(b);
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        const aPop = /(flash|mini|instant)/i.test(a) ? -1 : 0;
        const bPop = /(flash|mini|instant)/i.test(b) ? -1 : 0;
        if (aPop !== bPop) return aPop - bPop;
        return a.localeCompare(b);
      });

      return unique;
    } catch (err) {
      if (err instanceof LocalAIError) throw err;
      throw new LocalAIError(`Could not fetch models: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async detectProvider(apiKey: string): Promise<CloudProviderId | null> {
    return detectProvider(apiKey, this.request);
  }

  async testCloud(cloud: StoredCloudConfig): Promise<void> {
    const endpoint = cloud.endpoint.trim();
    const apiKey = cloud.apiKey.trim();
    const rawModel = cloud.model.trim() || CLOUD_PRESETS[cloud.provider]?.defaultModel || '';
    const model = normalizeCloudModel(cloud.provider, rawModel);
    if (!endpoint.startsWith('https://') && !endpoint.startsWith('http://127.0.0.1') && !endpoint.startsWith('http://localhost')) {
      throw new LocalAIError('Cloud API endpoint must use HTTPS.');
    }
    if (!apiKey) throw new LocalAIError('Enter your API key first.');
    if (!model) throw new LocalAIError('Enter a model name first.');

    console.log(`[Cloud AI] Test request model: ${model}`);

    try {
      const response = await this.request(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Say OK' }],
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        let cleanMsg = '';
        try {
          const parsed = JSON.parse(detail);
          cleanMsg = extractErrorMessage(parsed);
        } catch {}

        if (response.status === 401 || response.status === 403) {
          throw new LocalAIError('Invalid API key or unauthorized request. Check your API key and provider.');
        }
        if (response.status === 404) {
          throw new LocalAIError(`Model not found (404): "${model}". Click "Auto-Detect Models" to pick an available model.`);
        }
        if (response.status === 429) {
          throw new LocalAIError(`Rate limit reached (429) for "${model}". Please select a lighter model or wait a few minutes.`);
        }
        throw new LocalAIError(`Cloud API error (${response.status}): ${cleanMsg || detail.slice(0, 120) || 'Check model name and endpoint.'}`);
      }
    } catch (error) {
      if (error instanceof LocalAIError) throw error;
      throw new LocalAIError('Could not connect to Cloud API. Check your internet connection and endpoint URL.');
    }
  }

  private async streamCloud(cloud: StoredCloudConfig, messages: ModelMessage[], signal: AbortSignal, onText: (text: string) => void, options?: StreamOptions) {
    const endpoint = cloud.endpoint.trim();
    const apiKey = cloud.apiKey.trim();
    const rawModel = cloud.model.trim() || CLOUD_PRESETS[cloud.provider]?.defaultModel || '';
    const model = normalizeCloudModel(cloud.provider, rawModel);
    if (!apiKey) throw new LocalAIError('Cloud API key is missing. Add your API key in Settings → Local AI.');
    if (!model) throw new LocalAIError('Choose a Cloud API model in Settings → Local AI.');

    console.log(`[Cloud AI] Stream request model: ${model}`);
    const streamT0 = Date.now();

    const providerLabel = CLOUD_PRESETS[cloud.provider]?.label || cloud.provider;
    if (options?.tools && options.tools.definitions.length) {
      const toolSystem = buildSystemPrompt({ voice: options.voice, model, provider: providerLabel, tools: true });
      const toolMessages = options.voice
        ? [{ role: 'system' as const, content: toolSystem }, ...messages]
        : [{ role: 'system' as const, content: toolSystem }, ...FEW_SHOT_EXAMPLES, ...messages];
      try {
        const outcome = await runToolLoop({
          // Each model request has its own 60 s limit; waiting for the user's approval is not counted.
          fetchFn: (url, init) => this.request(url, { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(60_000)]) }),
          endpoint,
          apiKey,
          model,
          messages: toolMessages,
          tools: options.tools,
          signal,
          onText,
          maxTokens: cloud.provider === 'groq' ? 950 : 1500,
          onToolCall: name => console.log(`[Tools] model called ${name}`),
        });
        console.log(`[Tools] finished after ${outcome.steps} step(s), ${outcome.toolCalls} tool call(s)`);
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof ToolsUnsupportedError) {
          console.warn('[Tools] provider rejected tools; continuing with plain chat.');
        } else if (error instanceof ToolLoopHttpError) {
          if (error.status === 401 || error.status === 403) throw new LocalAIError('Cloud API key rejected (401/403). Check your key in Settings → Local AI.');
          if (error.status === 404) throw new LocalAIError('Model not found (404). Click "Auto-Detect Models" in Settings.');
          if (error.status === 0) throw new LocalAIError('Cloud API returned an empty reply. Please try again.');
          throw new LocalAIError(`Cloud API request failed (${error.status}): ${extractErrorMessage(safeJson(error.detail)) || error.detail.slice(0, 100) || 'Check your model in Settings.'}`);
        } else if (error instanceof LocalAIError) {
          throw error;
        } else {
          throw new LocalAIError(`Cloud API error: ${(error as Error)?.message || 'connection failed.'}`);
        }
      }
    }
    const systemPrompt = buildSystemPrompt({
      voice: options?.voice,
      model,
      provider: providerLabel,
    });
    const maxTokens = cloud.provider === 'groq' ? 950 : (options?.voice ? 1024 : 1500);

    const fullMessages = options?.voice
      ? [{ role: 'system' as const, content: systemPrompt }, ...messages]
      : [{ role: 'system' as const, content: systemPrompt }, ...FEW_SHOT_EXAMPLES, ...messages];

    console.log(`[Cloud AI Payload] Model: ${model}`, JSON.stringify(fullMessages.slice(-5), null, 2));

    const combined = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    try {
      let response: Response | null = null;
      let retries = 3;
      let delayMs = 2500;

      while (retries > 0) {
        response = await this.request(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: combined,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            stream: true,
            temperature: 0.6,
            top_p: 0.95,
            max_tokens: maxTokens,
            messages: fullMessages,
          }),
        });

        if (response.status === 429 && retries > 1) {
          console.warn(`[Cloud AI 429] Rate limited on ${model}. Retrying after ${delayMs}ms backoff...`);
          await new Promise(r => setTimeout(r, delayMs));
          delayMs *= 2;
          retries--;
          continue;
        }
        break;
      }

      if (!response || !response.ok || !response.body) {
        if (!response) {
          throw new LocalAIError('Cloud API connection failed: no response received.');
        }
        if (response.status === 401 || response.status === 403) {
          throw new LocalAIError('Cloud API key rejected (401/403). Check your key in Settings → Local AI.');
        }
        const detail = await response.text().catch(() => '');
        let clean = '';
        try {
          const parsed = JSON.parse(detail);
          clean = extractErrorMessage(parsed);
        } catch {}
        if (response.status === 404) {
          throw new LocalAIError(`Model not found (404): ${clean || detail.slice(0, 80)}. Click "Auto-Detect Models" in Settings.`);
        }
        throw new LocalAIError(`Cloud API request failed (${response.status}): ${clean || detail.slice(0, 100) || 'Check your model in Settings.'}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
        const payload = await response.json();
        const payloadError = extractErrorMessage(payload);
        if (payloadError) throw new LocalAIError(payloadError);
        const text = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
        if (typeof text === 'string' && text.trim()) {
          onText(text);
          return;
        }
        throw new LocalAIError('Cloud API returned an empty reply.');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', length = 0;
      const consumeSSE = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) return false;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return true;
        try {
          const chunk = JSON.parse(data);
          const chunkError = extractErrorMessage(chunk);
          if (chunkError) throw new LocalAIError(chunkError);
          const choices = (chunk as { choices?: { delta?: { content?: unknown }; message?: { content?: unknown }; finish_reason?: string }[] })?.choices;
          const finishReason = choices?.[0]?.finish_reason;
          if (finishReason) {
            console.log(`[Cloud AI] Stream finish_reason: "${finishReason}" ms=${Date.now() - streamT0}`);
            if (finishReason === 'length') {
              console.warn('[Cloud AI] Note: reply reached max_tokens length limit.');
            }
          }
          const text = choices?.[0]?.delta?.content ?? choices?.[0]?.message?.content;
          if (typeof text === 'string' && text) {
            length += text.length;
            if (length > 32_000) throw new LocalAIError('Reply length limit reached.');
            onText(text);
          }
        } catch (e) {
          if (e instanceof LocalAIError) throw e;
        }
        return false;
      };
      try {
        let done = false;
        while (!done) {
          const next = await reader.read();
          buffer += decoder.decode(next.value, { stream: !next.done });
          let idx: number;
          while (!done && (idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (consumeSSE(line)) done = true;
          }
          if (next.done) {
            if (!done && buffer.trim()) consumeSSE(buffer);
            break;
          }
        }
        if (!length) throw new LocalAIError('Cloud API returned an empty reply. Please try again.');
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (combined.aborted) throw new LocalAIError('Cloud API request timed out. Please try again.');
      if (error instanceof LocalAIError) throw error;
      const msg = (error as Error)?.message || 'Cloud API connection failed.';
      throw new LocalAIError(`Cloud API error: ${msg}`);
    }
  }

  async stream(model: string, messages: ModelMessage[], signal: AbortSignal, onText: (text: string) => void, options?: StreamOptions) {
    if (options?.vision) {
      try {
        const result = await runVisionChat({
          targets: options.vision.targets,
          system: buildSystemPrompt({ voice: options.voice, provider: 'cloud vision', toolsPaused: Boolean(options.tools) }),
          history: messages,
          fallbackText: options.vision.fallbackText,
          imageDataUri: options.vision.dataUri,
          signal,
          log: line => console.info(line),
        });
        onText(result.text);
        return;
      } catch (error) {
        if (error instanceof VisionError) throw new LocalAIError(error.message);
        throw error;
      }
    }
    if (options?.mode === 'cloud' && options.cloud) {
      return this.streamCloud(options.cloud, messages, signal, onText, options);
    }

    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
    // Handle common companion intents directly for instant, natural Roman Urdu in local mode
    if (lastUser) {
      const smartReply = smartRomanUrduReply(lastUser);
      if (smartReply) {
        onText(smartReply);
        return;
      }
    }

    const meta = classifyModelMeta(model);
    const tiny = isTinyModel(model, meta.paramSize) || meta.sizeMB <= 1200;
    const isHeavy = Boolean(options?.heavy ?? meta.heavy);
    const timeoutMs = isHeavy ? 45_000 : 120_000;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      // A cloud alias can exist in the local server. Verify actual local weights
      // before sending any conversation content to the selected model.
      const info = await this.request(`${BASE}/api/show`, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
      });
      if (!info.ok) throw new LocalAIError('This model is unavailable. Open Settings → Local AI and check the connection.');
      const details = await info.json() as { remote_host?: unknown; remote_model?: unknown; model_info?: Record<string, unknown> };
      if (details.remote_host || details.remote_model || typeof details.model_info?.['general.architecture'] !== 'string') {
        throw new LocalAIError('Choose a downloaded local model. Cloud models are not supported in local mode.');
      }
      const systemPrompt = options?.voice
        ? "You are Sudo-chan, speaking aloud to your creator and developer Sid. Reply in the user's language, in 1-3 short natural spoken sentences. No markdown, no lists, no emojis. Answer the question directly and warmly in Roman Urdu or English."
        : SYSTEM;
      const seededMessages = [
        { role: 'system' as const, content: systemPrompt },
        ...messages,
      ];
      console.log(`[Ollama payload] Model: ${model}`, JSON.stringify(seededMessages, null, 2));
      const response = await this.request(`${BASE}/api/chat`, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: true,
          messages: seededMessages,
          options: {
            num_ctx: 2048,
            num_predict: isHeavy ? 250 : 384,
            temperature: 0.45,
            top_p: 0.9,
            repeat_penalty: 1.15,
          },
          keep_alive: isHeavy ? '30s' : '2m',
        }),
      });
      if (!response.ok || !response.body) {
        throw new LocalAIError(
          isHeavy
            ? `⚠️ ${model} (${meta.sizeLabel}) is too heavy for available RAM. Switch to qwen2.5:0.5b or Cloud API.`
            : 'Ollama could not start the reply. Try qwen2.5:0.5b or Cloud API in Settings.',
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', done = false, length = 0, fullReply = '';
      const bufferTinyCheck = (tiny || meta.sizeMB <= 2200) && isRomanUrduInput(lastUser);
      const consume = (line: string) => {
        if (!line.trim()) return;
        const chunk = JSON.parse(line) as { error?: unknown; message?: { content?: unknown }; done?: boolean };
        if (chunk.error) throw new LocalAIError('The model stopped unexpectedly. Try qwen2.5:0.5b or Cloud API.');
        const text = chunk.message?.content;
        if (typeof text === 'string' && text) {
          length += text.length;
          if (length > 32_000) throw new LocalAIError('Reply length limit reached. Ask for a shorter answer.');
          fullReply += text;
          if (!bufferTinyCheck) onText(text);
        }
        if (chunk.done === true) done = true;
      };
      try {
        while (!done) {
          const next = await reader.read();
          buffer += decoder.decode(next.value, { stream: !next.done });
          if (buffer.length > 128_000) throw new Error('Oversized stream record');
          let index: number;
          while (!done && (index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); consume(line);
          }
          if (next.done) { if (!done && buffer.trim()) consume(buffer); break; }
        }
        if (!done) throw new LocalAIError('The connection ended before the reply finished. You can retry your message.');
        if (!length) throw new LocalAIError('The model returned an empty reply. Please try again.');
        if (bufferTinyCheck) {
          const sanitized = fullReply.replace(/[\u0600-\u06FF]+/g, '').trim();
          if (!sanitized || isGibberishRomanUrdu(sanitized, lastUser)) {
            onText(fallbackRomanUrduReply(lastUser));
          } else {
            onText(sanitized);
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) {
      if (signal.aborted) throw error;
      if (combined.aborted) {
        throw new LocalAIError(
          isHeavy
            ? `⚠️ ${model} (${meta.sizeLabel}) took too long and may hang your laptop. Switch to qwen2.5:0.5b or Cloud API!`
            : 'The model took too long. Try qwen2.5:0.5b or Cloud API for instant replies.',
        );
      }
      if (error instanceof LocalAIError) throw error;
      throw new LocalAIError(
        isHeavy
          ? `⚠️ ${model} (${meta.sizeLabel}) failed to load (too heavy for RAM). Switch to qwen2.5:0.5b or Cloud API.`
          : 'Local AI connection failed. Check that Ollama is running or switch to Cloud API.',
      );
    }
  }
}
