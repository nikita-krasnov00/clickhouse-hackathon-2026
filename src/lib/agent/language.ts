/**
 * Agent answer language.
 *
 * Previously every pipeline step (triage, SQL generation, annotation, verdict)
 * re-decided the language on its own via a soft "in the language of the
 * question" hint. That caused a bug: a short English question like "What's
 * suspicious about DashPlayer stars in spring 2024?" got answered in Russian,
 * because the system prompts are steeped in Russian examples («что странного…»,
 * «докажи», «воронка», «прочее») and the fast triage model drifted to their
 * language, emitting Russian titles that the rest of the board then inherited.
 *
 * Fix: decide the language ONCE, deterministically from the question text, and
 * hard-pin it on every LLM call via a dedicated directive that explicitly tells
 * the model to ignore the language of the examples in the instructions. UI
 * locale is intentionally not mixed in — by product design the source of truth
 * is the question itself (see catalog.ts).
 */

export type AnswerLanguage = "Russian" | "English";

/** Cyrillic in the question → Russian, otherwise English. */
export function detectAnswerLanguage(question: string): AnswerLanguage {
  return /[Ѐ-ӿ]/.test(question) ? "Russian" : "English";
}

/**
 * Strict language directive for the system prompt. Overrides any downstream
 * "language of the question" wording and the language of the Russian examples.
 */
export function languageDirective(question: string): string {
  const language = detectAnswerLanguage(question);
  return [
    "## Answer language (STRICT — overrides everything below)",
    `Write EVERY human-readable string you output — card titles, clarify questions and options, impossibility reasons, insights, metric notes, verdicts — in ${language}.`,
    "This is fixed by the user's question. The examples in these instructions are written in Russian ONLY to illustrate phrasing — do NOT copy their language.",
    "SQL identifiers and keywords stay as written. Never mix languages in one string.",
  ].join("\n");
}
