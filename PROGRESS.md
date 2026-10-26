# Sudo-chan Chatbot Quality Fix - Progress Log

## Status: IN PROGRESS
**Branch:** `chatbot-fix`
**Current Phase:** Step 2 - Optimization Loop & Model Evaluation

## Goals & Success Criteria
1. At least 90% of the 42 eval prompts pass, average judge score >= 8/10.
2. ZERO generic fallback replies (no "thora aur batao", "aur detail mein batao" unless question is truly unclear).
3. ZERO cut-off replies (finish_reason is "stop").
4. Identity and capability questions answered correctly with real facts (model, provider, features).
5. All existing tests pass and builds succeed.

## Iterations Summary
| Iteration | Model Under Test | Provider | Judge Model | Pass Rate | Avg Score | Generic Count | Cut-off Count | Latency | Status |
|-----------|------------------|----------|-------------|-----------|-----------|---------------|---------------|---------|--------|
| Iteration 0 (Baseline) | `gemini-3-flash-preview` | Gemini | `qwen/qwen3.8-27b` (Groq) | 21% (9/42) | 2.69/10 | 14 | 0 | 1205ms | Completed |
| Iteration 1 | `qwen/qwen3.8-27b` | Groq | `gemini-flash-lite-latest` (Gemini) | 74% (31/42) | 9.12/10 | 0 | 3 | 422ms | Completed |

## Iteration Details
### Iteration 0 (Baseline)
- Evaluated out-of-the-box local-ai chat behavior.
- **Root Cause Found:** `smartRomanUrduReply` intercepted requests before reaching cloud APIs and returned canned responses. Cloud errors fell back to `fallbackRomanUrduReply`, which returned the exact generic filler ("Aap jo bhi pooch rahe ho, thora sa aur khul kar batao") seen in the user's screenshot.
- Score: 2.69/10, 14 generic deflections, only 21% pass rate.

### Iteration 1
- **Changes Applied:**
  1. Rewrote system prompt in English (`buildSystemPrompt`) with direct, concise instructions, strict language matching, runtime facts (Sudo-chan, Sid, active model, provider, desktop features: Pomodoro, RAM monitor, Live Talk, kawaii glasses, quiet mode).
  2. Injected 5 high-quality few-shot examples (balanced English and Roman Urdu).
  3. Bypassed `smartRomanUrduReply` in cloud mode.
  4. Removed canned deflection fallbacks from `streamCloud` error handler.
  5. Set `max_tokens` to 950 for Groq (avoids Groq 1000 OTPM limit) and 1500 for Gemini.
- **Results:**
  - Average Judge Score surged from **2.69/10 -> 9.12/10** (+239% improvement).
  - Generic deflections dropped from **14 -> 0** (100% eliminated!).
  - Pass rate jumped from **21% -> 74%**.
- **Failures Analyzed:**
  - Harness heuristic false negatives: `id-2` and `gk-1` scored 10/10 but `detectLanguage` regex missed `aapka` or required >= 2 hits on single-word Urdu replies. Code block in `conv-1-3` caused language false negative. Responses ending with markdown formatting or `]` were falsely flagged as cut off despite `finish_reason === 'stop'`.
  - Real model weaknesses: When asked in English on unclear prompts ("Fix it please", "Can you help me stay focused while coding?"), model occasionally defaulted to Roman Urdu.

## Next Steps
1. Refine eval harness heuristics in `desktop/scripts/eval-chat.ts` (stop heuristic checks when `finish_reason === 'stop'` and expand Roman Urdu words in `detectLanguage`).
2. Add language matching rule emphasis in system prompt and balance few-shot examples so English prompts always get English replies.
3. Run Iteration 2 with `openai/gpt-oss-120b` (Groq).
4. Run Iteration 3 with `gemini-flash-lite-latest` (Gemini).
5. Compare models, set best model as default in config, verify `npm test`, and produce `REPORT.md`.
