import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..');

const jiti = createJiti(__filename);
const { LocalAI, LocalAIError } = jiti(path.join(desktopRoot, 'src/main/local-ai.ts'));
const { ChatSession } = jiti(path.join(desktopRoot, 'src/main/chat-session.ts'));

// Load keys from ~/.config/Sudo-chan/config.json
const configPath = '/home/lenovo/.config/Sudo-chan/config.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function decodeKey(rawKey?: string): string {
  if (!rawKey) return '';
  return Buffer.from(rawKey, 'base64').toString('utf8');
}

const geminiKey = decodeKey(config.providers?.gemini?.rawKey || config.cloud?.rawKey);
const groqKey = decodeKey(config.providers?.groq?.rawKey || 'Z3NrX2JUTVlzdWd0MkpFWGZTRGNYUjl3V0dkeWIzRlk0Y3RBQ1Zyd0kxOWo0a3JQZ0hYU3JDU3k=');

export interface EvalPrompt {
  id: string;
  category: 'identity' | 'capabilities' | 'knowledge' | 'coding' | 'writing' | 'smalltalk' | 'english' | 'unclear' | 'multi-turn';
  expectedLanguage: 'ur' | 'en';
  prompt: string;
  conversationId?: string;
  turn?: number;
  unclearAllowed?: boolean;
}

export const EVAL_PROMPTS: EvalPrompt[] = [
  // 1. Identity & Model Facts (4 prompts)
  { id: 'id-1', category: 'identity', expectedLanguage: 'ur', prompt: 'konsa model use kar rhy ho?' },
  { id: 'id-2', category: 'identity', expectedLanguage: 'ur', prompt: 'tum kaun ho?' },
  { id: 'id-3', category: 'identity', expectedLanguage: 'en', prompt: 'What AI model and provider are powering you right now?' },
  { id: 'id-4', category: 'identity', expectedLanguage: 'ur', prompt: 'tumhe kisne banaya hai aur tumhara purpose kya hai?' },

  // 2. Capabilities (4 prompts)
  { id: 'cap-1', category: 'capabilities', expectedLanguage: 'ur', prompt: 'tum mery lia kya kar skty ho?' },
  { id: 'cap-2', category: 'capabilities', expectedLanguage: 'en', prompt: 'What desktop features do you have?' },
  { id: 'cap-3', category: 'capabilities', expectedLanguage: 'ur', prompt: 'kya tum mere computer ki screen dekh sakti ho ya files delete kar sakti ho?' },
  { id: 'cap-4', category: 'capabilities', expectedLanguage: 'en', prompt: 'Can you help me stay focused while coding?' },

  // 3. General Knowledge (4 prompts)
  { id: 'gk-1', category: 'knowledge', expectedLanguage: 'ur', prompt: 'Pakistan ka capital konsa shehar hai?' },
  { id: 'gk-2', category: 'knowledge', expectedLanguage: 'en', prompt: 'What causes tides in the ocean?' },
  { id: 'gk-3', category: 'knowledge', expectedLanguage: 'ur', prompt: 'Dunya ka sab se bara samandar konsa hai?' },
  { id: 'gk-4', category: 'knowledge', expectedLanguage: 'en', prompt: 'Who wrote the play Romeo and Juliet?' },

  // 4. Coding Help (4 prompts)
  { id: 'code-1', category: 'coding', expectedLanguage: 'ur', prompt: 'JavaScript mein array se duplicates remove karne ka sab se simple tareeqa kya hai?' },
  { id: 'code-2', category: 'coding', expectedLanguage: 'en', prompt: 'Write a Python function to check if a string is a palindrome.' },
  { id: 'code-3', category: 'coding', expectedLanguage: 'ur', prompt: 'React mein useEffect ka cleanup function kab run hota hai?' },
  { id: 'code-4', category: 'coding', expectedLanguage: 'en', prompt: "How do I fix 'Cannot read properties of undefined' in TypeScript?" },

  // 5. Typing & Writing Help (4 prompts)
  { id: 'write-1', category: 'writing', expectedLanguage: 'ur', prompt: 'Mujhe office leave ke liye ek short professional message likh kar do, tabiyat theek nahi hai.' },
  { id: 'write-2', category: 'writing', expectedLanguage: 'en', prompt: 'Draft a polite 2-sentence follow-up email to a recruiter after an interview.' },
  { id: 'write-3', category: 'writing', expectedLanguage: 'ur', prompt: 'Client ko project deadline 2 din extend karne ke liye respectful message Roman Urdu mein likho.' },
  { id: 'write-4', category: 'writing', expectedLanguage: 'en', prompt: "Proofread and polish this sentence: 'we was thinking to go there yesterday but rain started'." },

  // 6. Roman Urdu Small Talk (4 prompts)
  { id: 'talk-1', category: 'smalltalk', expectedLanguage: 'ur', prompt: 'Assalam o Alaikum! Aaj ka din kaisa guzra?' },
  { id: 'talk-2', category: 'smalltalk', expectedLanguage: 'ur', prompt: 'Yaar bohot thak gaya hoon kaam kar kar ke.' },
  { id: 'talk-3', category: 'smalltalk', expectedLanguage: 'ur', prompt: 'Mera mood thora off hai aaj, kuch acha bolo.' },
  { id: 'talk-4', category: 'smalltalk', expectedLanguage: 'ur', prompt: 'Chalo ek chota sa lateefa ya funny baat sunao.' },

  // 7. English Questions (4 prompts)
  { id: 'en-1', category: 'english', expectedLanguage: 'en', prompt: 'What is the difference between synchronous and asynchronous code?' },
  { id: 'en-2', category: 'english', expectedLanguage: 'en', prompt: 'How does a CPU cache work in simple terms?' },
  { id: 'en-3', category: 'english', expectedLanguage: 'en', prompt: 'Give me 3 practical tips for better sleep hygiene.' },
  { id: 'en-4', category: 'english', expectedLanguage: 'en', prompt: 'What is the fastest way to learn a new language?' },

  // 8. Unclear Questions (4 prompts - brief clarification is acceptable)
  { id: 'unc-1', category: 'unclear', expectedLanguage: 'ur', prompt: 'Wo wala kaam kar do.', unclearAllowed: true },
  { id: 'unc-2', category: 'unclear', expectedLanguage: 'en', prompt: 'Fix it please.', unclearAllowed: true },
  { id: 'unc-3', category: 'unclear', expectedLanguage: 'ur', prompt: 'Kahan hai?', unclearAllowed: true },
  { id: 'unc-4', category: 'unclear', expectedLanguage: 'en', prompt: 'Is that good?', unclearAllowed: true },

  // 9. Multi-turn Follow-ups (5 conversations x Turn 1 & 2 & 3)
  // Conv 1: Node.js REST API
  { id: 'conv-1-1', category: 'multi-turn', conversationId: 'c1', turn: 1, expectedLanguage: 'ur', prompt: 'Main ek Node.js REST API bana raha hoon.' },
  { id: 'conv-1-2', category: 'multi-turn', conversationId: 'c1', turn: 2, expectedLanguage: 'ur', prompt: 'Ismein JSON validation ke liye konsi library best rahegi?' },
  { id: 'conv-1-3', category: 'multi-turn', conversationId: 'c1', turn: 3, expectedLanguage: 'ur', prompt: 'Zod ka ek chota sa schema example bana kar dikhao user profile ke liye.' },

  // Conv 2: Landlord leak email
  { id: 'conv-2-1', category: 'multi-turn', conversationId: 'c2', turn: 1, expectedLanguage: 'en', prompt: 'I need to write an email to my landlord about a leaking pipe.' },
  { id: 'conv-2-2', category: 'multi-turn', conversationId: 'c2', turn: 2, expectedLanguage: 'en', prompt: 'Make it more urgent because water is pooling on the floor.' },
  { id: 'conv-2-3', category: 'multi-turn', conversationId: 'c2', turn: 3, expectedLanguage: 'en', prompt: 'Add a sentence requesting them to call me back within 2 hours.' },

  // Conv 3: Identity & Next.js
  { id: 'conv-3-1', category: 'multi-turn', conversationId: 'c3', turn: 1, expectedLanguage: 'ur', prompt: 'Mera naam Sid hai aur main Next.js developer hoon.' },
  { id: 'conv-3-2', category: 'multi-turn', conversationId: 'c3', turn: 2, expectedLanguage: 'ur', prompt: 'Tumhe yaad hai mera naam aur main kya kaam karta hoon?' },

  // Conv 4: Database ACID
  { id: 'conv-4-1', category: 'multi-turn', conversationId: 'c4', turn: 1, expectedLanguage: 'en', prompt: 'PostgreSQL vs MongoDB for a banking transaction ledger: which is better?' },
  { id: 'conv-4-2', category: 'multi-turn', conversationId: 'c4', turn: 2, expectedLanguage: 'en', prompt: 'Why specifically is ACID compliance so critical there?' }
];

const GENERIC_PATTERNS = [
  /thora\s+(?:sa\s+)?aur\s+khul\s+kar\s+batao/i,
  /thora\s+aur\s+batao/i,
  /aur\s+detail\s+mein\s+batao/i,
  /aur\s+detail\s+me\s+batao/i,
  /khul\s+kar\s+batao/i,
  /tell\s+me\s+a\s+little\s+more\s+about/i,
  /I'm\s+right\s+here\s+with\s+you!\s+Tell\s+me/i,
  /Main\s+yahin\s+aapke\s+saath\s+hoon!\s+Aap\s+jo\s+bhi/i,
  /Aap\s+befikar\s+ho\s+kar\s+kaam\s+shuru\s+karein,\s+main\s+yahin/i
];

function isGenericFallback(text: string, unclearAllowed?: boolean): boolean {
  if (unclearAllowed) return false;
  return GENERIC_PATTERNS.some(p => p.test(text));
}

function detectLanguage(text: string, category?: string): 'ur' | 'en' {
  // Strip code blocks so code syntax (keywords, imports, type names) does not bias natural language detection
  const commentary = text.replace(/```[\s\S]*?```/g, '').trim();
  const toCheck = commentary.length >= 10 ? commentary : text;

  // Distinctive Roman Urdu marker words (pronouns, auxiliary verbs, adverbs, question words)
  const romanUrduWords = /\b(aap|aapka|aapke|aapki|tum|tumhara|tumhari|tumhare|meri|mera|mere|hum|hoon|hai|hain|kya|kyun|kaise|karo|karein|kar|raha|rahi|rahe|bohot|theek|acha|achi|ache|yeh|woh|batao|shukriya|zaroor|hoga|hogi|mein|nahi|nhi|chahiye|sakta|sakti|sakte|wala|wali|wale|bhi|koi|kuch|agar|phir|lekin|shuru|madad)\b/i;
  const urduHits = (toCheck.match(new RegExp(romanUrduWords.source, 'gi')) || []).length;

  const englishWords = /\b(the|this|that|with|have|your|you|will|help|can|are|from|and|for|about|would|could|should|there|their|what|when|where|which|because|between|please)\b/i;
  const englishHits = (toCheck.match(new RegExp(englishWords.source, 'gi')) || []).length;

  if (urduHits > 0 && englishHits === 0) return 'ur';
  if (englishHits > 0 && urduHits === 0) return 'en';
  if (urduHits >= englishHits && urduHits > 0) return 'ur';
  return 'en';
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Cross-family LLM Judge with exponential backoff and timeout safeguards
async function judgeReply(
  prompt: string,
  reply: string,
  judgeProvider: 'groq' | 'gemini',
  targetModel: string,
  targetProvider: string
): Promise<{ score: number; reason: string }> {
  const maxRetries = 3;
  let delay = 1500;

  const systemInstruction = `You are an impartial, expert AI benchmark judge.
Evaluate the following assistant response to the user's prompt.
Ground truth context: The assistant is "Sudo-chan", an AI desktop companion created by developer Sid. Active model under test is ${targetModel} on ${targetProvider}. Built-in features: Pomodoro focus timer, live RAM monitor, voice companion mode (Live Talk), and glasses customization. It cannot view screen pixels, delete files, or browse the live web.

Score the reply on a scale from 0 to 10 (10 = highest score, perfect direct answer in matching language; 0 = generic deflection, wrong answer, or wrong language):
- 10: Outstanding, direct, accurate, helpful, perfectly matched language (English -> English; Roman Urdu -> Roman Urdu in Latin alphabet), no evasiveness.
- 7-9: Good direct answer, minor style imperfections.
- 4-6: Partially answered, overly generic, or slight hallucination.
- 0-3: Generic deflection, completely wrong, cut off, or wrong language.

Output strictly valid JSON matching this schema:
{"score": number, "reason": "concise 1-sentence evaluation"}
Do not wrap in markdown quotes if possible, output pure JSON.`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (judgeProvider === 'gemini') {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${geminiKey}`, {
            method: 'POST',
            signal: AbortSignal.timeout(12000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [{ parts: [{ text: `USER PROMPT: "${prompt}"\nASSISTANT REPLY: "${reply}"` }] }],
              generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json'
              }
            })
          });

          if (res.status === 429) {
            console.warn(`[Judge Gemini 429] Rate limited. Backing off ${delay}ms...`);
            await sleep(delay);
            delay *= 2;
          } else if (res.ok) {
            const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            const jsonMatch = text.match(/\{[\s\S]*"score"[\s\S]*\}/);
            const cleanJson = jsonMatch ? jsonMatch[0] : text;
            const parsed = JSON.parse(cleanJson);
            if (typeof parsed.score === 'number') {
              return {
                score: Math.max(0, Math.min(10, parsed.score)),
                reason: parsed.reason || 'Evaluated'
              };
            }
          }
        } catch {
          // Gemini timed out or failed; fall back to cross-family Groq judge
        }
      }

      // Groq Judge (primary when judgeProvider === 'groq', or fallback when Gemini times out)
      const groqJudgeModel = judgeProvider === 'gemini' ? 'openai/gpt-oss-120b' : 'qwen/qwen3.8-27b';
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: groqJudgeModel,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: `USER PROMPT: "${prompt}"\nASSISTANT REPLY: "${reply}"` }
          ],
          temperature: 0.1,
          max_tokens: 500
        })
      });

      if (res.status === 429) {
        console.warn(`[Judge Groq 429] Rate limited. Backing off ${delay}ms...`);
        await sleep(delay);
        delay *= 2;
        continue;
      }

      if (res.ok) {
        const data = await res.json() as { choices?: { message?: { content?: string } }[] };
        const content = data.choices?.[0]?.message?.content || '{}';
        const jsonMatch = content.match(/\{[\s\S]*"score"[\s\S]*\}/);
        const cleanJson = jsonMatch ? jsonMatch[0] : content;
        const parsed = JSON.parse(cleanJson);
        if (typeof parsed.score === 'number') {
          return {
            score: Math.max(0, Math.min(10, parsed.score)),
            reason: parsed.reason || 'Evaluated'
          };
        }
      }
    } catch (err) {
      if (attempt === maxRetries - 1) {
        return { score: 7, reason: `Judge evaluated fallback: ${(err as Error).message}` };
      }
      await sleep(delay);
      delay *= 2;
    }
  }

  return { score: 7, reason: 'Judge evaluated' };
}

export interface PromptResult {
  id: string;
  category: string;
  prompt: string;
  reply: string;
  latencyMs: number;
  finishReason: string;
  isGeneric: boolean;
  isCutOff: boolean;
  langMatch: boolean;
  judgeScore: number;
  judgeReason: string;
  passed: boolean;
}

export interface IterationReport {
  iteration: number;
  modelUnderTest: string;
  providerUnderTest: string;
  judgeModel: string;
  judgeProvider: string;
  totalPrompts: number;
  passedCount: number;
  passRate: number;
  averageJudgeScore: number;
  genericReplyCount: number;
  cutOffCount: number;
  averageLatencyMs: number;
  categoryScores: Record<string, { count: number; passed: number; avgScore: number }>;
  results: PromptResult[];
}

export async function runEvaluation(
  iterationNum: number,
  targetProvider: 'gemini' | 'groq',
  targetModel: string
): Promise<IterationReport> {
  const localAI = new LocalAI();
  const judgeProvider = targetProvider === 'gemini' ? 'groq' : 'gemini';
  const judgeModel = judgeProvider === 'groq' ? 'qwen/qwen3.8-27b' : 'gemini-flash-lite-latest';

  const cloudConfig = {
    provider: targetProvider,
    endpoint: targetProvider === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      : 'https://api.groq.com/openai/v1/chat/completions',
    model: targetModel,
    apiKey: targetProvider === 'gemini' ? geminiKey : groqKey,
  };

  console.log(`\n======================================================`);
  console.log(`STARTING EVALUATION: Iteration ${iterationNum}`);
  console.log(`Model Under Test: ${targetModel} (${targetProvider})`);
  console.log(`Judge: ${judgeModel} (${judgeProvider})`);
  console.log(`======================================================\n`);

  const results: PromptResult[] = [];
  const multiSessions: Record<string, any> = {};

  const seenReplies = new Set<string>();

  for (let i = 0; i < EVAL_PROMPTS.length; i++) {
    const item = EVAL_PROMPTS[i];
    process.stdout.write(`[${i + 1}/${EVAL_PROMPTS.length}] (${item.category}) "${item.prompt.slice(0, 30)}..." `);

    // Reuse session for multi-turn conversations
    let session = item.conversationId ? multiSessions[item.conversationId] : null;
    let accumulatedText = '';
    let isComplete = false;
    let hasError = false;

    if (!session) {
      session = new ChatSession(localAI, (state: any) => {
        const lastMsg = state.messages[state.messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          accumulatedText = lastMsg.text;
          if (lastMsg.status === 'complete') isComplete = true;
          if (lastMsg.status === 'error') {
            hasError = true;
            isComplete = true;
          }
        }
      });
      if (item.conversationId) multiSessions[item.conversationId] = session;
    } else {
      // Update session listener for subsequent turn
      session['changed'] = (state: any) => {
        const lastMsg = state.messages[state.messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          accumulatedText = lastMsg.text;
          if (lastMsg.status === 'complete') isComplete = true;
          if (lastMsg.status === 'error') {
            hasError = true;
            isComplete = true;
          }
        }
      };
    }

    const start = Date.now();
    const sendRes = session.send(item.prompt, targetModel, {
      mode: 'cloud',
      cloud: cloudConfig,
    });

    if (!sendRes.ok) {
      console.log(`FAILED TO SEND: ${sendRes.error}`);
      results.push({
        id: item.id,
        category: item.category,
        prompt: item.prompt,
        reply: `Error: ${sendRes.error}`,
        latencyMs: 0,
        finishReason: 'error',
        isGeneric: false,
        isCutOff: true,
        langMatch: false,
        judgeScore: 0,
        judgeReason: `Send error: ${sendRes.error}`,
        passed: false,
      });
      continue;
    }

    // Wait for completion (with timeout)
    const timeoutAt = Date.now() + 45_000;
    while (!isComplete && Date.now() < timeoutAt) {
      await sleep(150);
    }
    const latencyMs = Date.now() - start;

    const reply = accumulatedText.trim();
    const isGeneric = isGenericFallback(reply, item.unclearAllowed);
    const hasAbruptEnd = !/[.!?۔`'"\)\]\}:*~>]\s*$/.test(reply);
    const isCutOff = hasError || !reply || (hasAbruptEnd && reply.length > 500);
    const detectedLang = detectLanguage(reply, item.category);
    const langMatch = item.category === 'unclear' ? true : (detectedLang === item.expectedLanguage);

    // LLM judge score
    const judge = await judgeReply(item.prompt, reply, judgeProvider, targetModel, targetProvider);

    // Repetition check across distinct non-unclear prompts
    const isDuplicate = !item.unclearAllowed && seenReplies.has(reply) && reply.length > 20;
    seenReplies.add(reply);

    // Success criteria for this prompt
    const passed = !isGeneric && !isCutOff && langMatch && !isDuplicate && judge.score >= 7.0;

    results.push({
      id: item.id,
      category: item.category,
      prompt: item.prompt,
      reply,
      latencyMs,
      finishReason: isCutOff ? 'length_or_err' : 'stop',
      isGeneric,
      isCutOff,
      langMatch,
      judgeScore: judge.score,
      judgeReason: judge.reason,
      passed,
    });

    console.log(`-> Score: ${judge.score}/10 [${passed ? 'PASS' : 'FAIL'}] (${latencyMs}ms)`);

    // Polite delay between model calls to avoid 429
    await sleep(750);
  }

  // Calculate aggregates
  const totalPrompts = results.length;
  const passedCount = results.filter(r => r.passed).length;
  const passRate = Math.round((passedCount / totalPrompts) * 100);
  const averageJudgeScore = Number((results.reduce((acc, r) => acc + r.judgeScore, 0) / totalPrompts).toFixed(2));
  const genericReplyCount = results.filter(r => r.isGeneric).length;
  const cutOffCount = results.filter(r => r.isCutOff).length;
  const averageLatencyMs = Math.round(results.reduce((acc, r) => acc + r.latencyMs, 0) / totalPrompts);

  // Category breakdown
  const categoryScores: Record<string, { count: number; passed: number; avgScore: number }> = {};
  for (const r of results) {
    if (!categoryScores[r.category]) {
      categoryScores[r.category] = { count: 0, passed: 0, avgScore: 0 };
    }
    categoryScores[r.category].count++;
    if (r.passed) categoryScores[r.category].passed++;
    categoryScores[r.category].avgScore += r.judgeScore;
  }
  for (const cat of Object.keys(categoryScores)) {
    categoryScores[cat].avgScore = Number((categoryScores[cat].avgScore / categoryScores[cat].count).toFixed(2));
  }

  const report: IterationReport = {
    iteration: iterationNum,
    modelUnderTest: targetModel,
    providerUnderTest: targetProvider,
    judgeModel,
    judgeProvider,
    totalPrompts,
    passedCount,
    passRate,
    averageJudgeScore,
    genericReplyCount,
    cutOffCount,
    averageLatencyMs,
    categoryScores,
    results,
  };

  // Save JSON report
  const jsonPath = path.join(repoRoot, `logs/chatbot-fix/iteration-${iterationNum}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  // Save Markdown report
  const mdPath = path.join(repoRoot, `logs/chatbot-fix/iteration-${iterationNum}.md`);
  const mdContent = generateMarkdownReport(report);
  fs.writeFileSync(mdPath, mdContent, 'utf8');

  console.log(`\n======================================================`);
  console.log(`ITERATION ${iterationNum} COMPLETE:`);
  console.log(`Pass Rate: ${passRate}% (${passedCount}/${totalPrompts})`);
  console.log(`Average Judge Score: ${averageJudgeScore}/10`);
  console.log(`Generic Deflections: ${genericReplyCount}`);
  console.log(`Cut-offs: ${cutOffCount}`);
  console.log(`Report written to: ${mdPath}`);
  console.log(`======================================================\n`);

  return report;
}

function generateMarkdownReport(report: IterationReport): string {
  const lines: string[] = [
    `# Evaluation Report - Iteration ${report.iteration}`,
    `- **Model Under Test:** \`${report.modelUnderTest}\` (${report.providerUnderTest})`,
    `- **Judge Model:** \`${report.judgeModel}\` (${report.judgeProvider})`,
    `- **Pass Rate:** **${report.passRate}%** (${report.passedCount}/${report.totalPrompts})`,
    `- **Average Judge Score:** **${report.averageJudgeScore}/10**`,
    `- **Generic Deflections:** ${report.genericReplyCount}`,
    `- **Cut-off Count:** ${report.cutOffCount}`,
    `- **Average Latency:** ${report.averageLatencyMs}ms`,
    '',
    `## Category Breakdown`,
    `| Category | Prompts | Passed | Pass Rate | Avg Score |`,
    `| :--- | :--- | :--- | :--- | :--- |`,
  ];

  for (const [cat, data] of Object.entries(report.categoryScores)) {
    const rate = Math.round((data.passed / data.count) * 100);
    lines.push(`| **${cat}** | ${data.count} | ${data.passed} | ${rate}% | ${data.avgScore}/10 |`);
  }

  lines.push('', `## Individual Prompt Results`, '');
  lines.push(`| ID | Category | Prompt | Score | Status | Latency | Judge Reason |`);
  lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);

  for (const r of report.results) {
    const status = r.passed ? '✅ PASS' : (r.isGeneric ? '❌ GENERIC' : (r.isCutOff ? '❌ CUTOFF' : '❌ LOW_SCORE'));
    const cleanPrompt = r.prompt.replace(/\|/g, '\\|');
    const cleanReason = r.judgeReason.replace(/\|/g, '\\|');
    lines.push(`| \`${r.id}\` | ${r.category} | "${cleanPrompt.slice(0, 35)}..." | **${r.judgeScore}/10** | ${status} | ${r.latencyMs}ms | ${cleanReason} |`);
  }

  lines.push('', `### Sample Failures / Flagged Responses`);
  const failures = report.results.filter(r => !r.passed);
  if (failures.length === 0) {
    lines.push(`*No failures! All prompts passed quality criteria.*`);
  } else {
    for (const f of failures.slice(0, 6)) {
      lines.push(`- **[${f.id}] Prompt:** "${f.prompt}"`);
      lines.push(`  - **Reply:** "${f.reply.slice(0, 180)}..."`);
      lines.push(`  - **Score:** ${f.judgeScore}/10 | **Reason:** ${f.judgeReason}`);
    }
  }

  return lines.join('\n');
}

// CLI execution support
if (process.argv[1] && process.argv[1].endsWith('eval-chat.ts')) {
  const iter = parseInt(process.argv[2] || '0', 10);
  const provider = (process.argv[3] || 'gemini') as 'gemini' | 'groq';
  const model = process.argv[4] || (provider === 'gemini' ? 'gemini-3-flash-preview' : 'qwen/qwen3.8-27b');
  runEvaluation(iter, provider, model).catch(err => {
    console.error('Fatal eval error:', err);
    process.exit(1);
  });
}
