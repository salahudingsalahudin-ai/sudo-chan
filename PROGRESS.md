# Sudo-chan Chatbot Quality Fix - Progress Log

## Status: IN PROGRESS
**Branch:** `chatbot-fix`
**Current Phase:** Step 1 - Evaluation Harness & Baseline Setup

## Goals & Success Criteria
1. At least 90% of the 40 eval prompts pass, average judge score >= 8/10.
2. ZERO generic fallback replies (no "thora aur batao", "aur detail mein batao" unless question is truly unclear).
3. ZERO cut-off replies (finish_reason is "stop").
4. Identity and capability questions answered correctly with real facts (model, provider, features).
5. All existing tests pass and builds succeed.

## Iterations Summary
| Iteration | Model Under Test | Judge Model | Pass Rate | Avg Score | Generic Count | Cut-off Count | Latency | Status |
|-----------|------------------|-------------|-----------|-----------|---------------|---------------|---------|--------|
| Baseline  | Pending          | Pending     | -         | -         | -             | -             | -       | Ready  |

## Current State
- **Done:**
  - Created git branch `chatbot-fix` and committed initial state.
  - Verified API keys for both Gemini and Groq exist and work (Groq status 200, Gemini status 200).
  - Listed active models on Groq (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`, etc.).
- **Next:**
  - Build evaluation harness `scripts/eval-chat.ts` (or `desktop/scripts/eval-chat.ts`) using the real app chat code path (`chat-session.ts` and `local-ai.ts`).
  - Assemble the 40 test prompts across all required categories (identity, capabilities, knowledge, coding, writing, Roman Urdu small talk, English questions, multi-turn follow-ups, unclear questions).
  - Implement the cross-family LLM judge (Gemini judges Groq, Groq judges Gemini) with 0-10 scoring and automatic failure checks.
  - Run baseline evaluation (Iteration 0) and log results to `logs/chatbot-fix/iteration-0.json` and `iteration-0.md`.
- **Blockers:**
  - None. Both keys functional.
