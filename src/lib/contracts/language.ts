/**
 * Run language — the single source of truth for which language a run speaks.
 *
 * The answer (card titles, insights, verdict) and the reasoning stream (step
 * labels and messages) must both follow the SAME language, so that one run is
 * never split across two languages. There is no separate UI locale in the
 * project; by product design the signal is the question text itself.
 *
 * Kept in contracts (not lib/agent) because both the server pipeline and the
 * client components need it, and contracts is the shared client/server package.
 */

export type AnswerLanguage = "Russian" | "English";

/** Cyrillic in the question → Russian, otherwise English. */
export function detectAnswerLanguage(question: string): AnswerLanguage {
  return /[Ѐ-ӿ]/.test(question) ? "Russian" : "English";
}
