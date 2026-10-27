import type { ToolRuntimeLike } from './types.js';

/**
 * Token saver for tool turns. Every request of a tool turn re-sends the whole tool list (about 1,100 tokens for notes, reminders and the
 * seven planner tools, plus about 200 tokens of prompt lines for them) and Groq's free tier allows only 7,000 input tokens a minute for the
 * main model. The file/command tools are always offered; the "personal organiser" tools (notes, reminders, tasks) are only offered when the
 * conversation is about them. The gate errs on the side of OFFERING them: a false positive only costs tokens, a false negative would hide a tool.
 */
export const PLANNER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'save_note', 'list_notes', 'read_note',
  'set_reminder', 'list_reminders', 'cancel_reminder',
  'add_task', 'list_tasks', 'update_task', 'complete_task', 'plan_today', 'next_task', 'start_task',
]);

const PLANNER_WORDS = new RegExp([
  // English
  String.raw`\b(?:tasks?|to-?dos?|remind(?:er|ers|s|ed)?|notes?|notebook|plan|plans|planner|agenda|schedule|scheduled|deadline|deadlines|due|checklist|alarm|timer|tomorrow|tonight|today's)\b`,
  // Roman Urdu
  String.raw`\b(?:kaam|kam|yaad|yad|dilana|dila|dilao|plan|agla|agli|pehla|pehli|khatam|mukammal|complete|finish|done|baje|minutes?|mins?|ghant[ae]|hours?|hafte|kal|parson)\b`,
  // Urdu script
  '\\u06A9\\u0627\\u0645|\\u06CC\\u0627\\u062F|\\u0646\\u0648\\u0679|\\u0679\\u0627\\u0633\\u06A9|\\u0631\\u06CC\\u0645\\u0627\\u0626\\u0646\\u0688\\u0631|\\u067E\\u0644\\u0627\\u0646|\\u0645\\u0646\\u0635\\u0648\\u0628',
  // Tool names in earlier messages (the history note of start_task reads "started task t1", which the word list above already catches)
  String.raw`(?:add|list|update|complete|start)_tasks?|plan_today|next_task|(?:save|list|read)_notes?|(?:set|list|cancel)_reminders?`,
].join('|'), 'iu');

/** How many of the latest messages (newest first) can make the gate say yes: the question itself plus the exchange before it ("haan kar do"). */
export const GATE_LOOKBACK = 3;

/** True when the latest user message, or the exchange right before it, talks about tasks, reminders, notes or the day's plan. */
export function wantsPlannerTools(messages: ReadonlyArray<{ role: string; content: string }>): boolean {
  const recent = messages.filter(m => m.role !== 'system').slice(-GATE_LOOKBACK);
  return recent.some(m => typeof m.content === 'string' && PLANNER_WORDS.test(m.content));
}

/** The same runtime (same execute, same approvals and audit) but without the planner tools in the list the model sees. */
export function withoutPlannerTools(runtime: ToolRuntimeLike): ToolRuntimeLike {
  const definitions = runtime.definitions.filter(d => !PLANNER_TOOL_NAMES.has(d.function.name));
  // Never offer an empty list (providers reject `tools: []`): a runtime that only has planner tools keeps them.
  if (!definitions.length) return runtime;
  return {
    definitions,
    execute: (name, args, callId, signal) => runtime.execute(name, args, callId, signal),
  };
}
