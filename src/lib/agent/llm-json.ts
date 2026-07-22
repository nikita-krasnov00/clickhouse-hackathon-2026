/**
 * Shared layer for "strict JSON from the model": extract a JSON object from the
 * response (strip reasoning blocks and markdown fences) and a parsing safety
 * dialog — one retry request with the error text, then throw. Used by both the
 * SQL planner (generate-sql.ts) and triage (triage.ts).
 */
import { chatComplete, type ChatCompleteOptions, type ChatMessage } from "./llm";

/** Strip reasoning blocks and markdown fences, extract the JSON object. */
export function extractJsonObject(content: string): string {
  let text = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  text = text.replace(/```(?:json)?/gi, "").trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) {
    throw new Error("model response contains no JSON object");
  }
  return text.slice(first, last + 1);
}

/**
 * Model dialog with parsing safety: on invalid JSON — one retry request with
 * the error text, then throw (caught by the caller).
 */
export async function askAndParse<T>(
  messages: ChatMessage[],
  parse: (content: string) => T,
  options: ChatCompleteOptions & { purpose: string },
): Promise<T> {
  const { content } = await chatComplete(messages, options);
  try {
    return parse(content);
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    const retry = await chatComplete(
      [
        ...messages,
        { role: "assistant", content },
        {
          role: "user",
          content:
            `Your previous reply could not be used: ${parseError}\n` +
            `Reply again with ONLY the strict JSON described in the system prompt — no markdown, no prose.`,
        },
      ],
      { ...options, purpose: `${options.purpose}:reparse` },
    );
    return parse(retry.content);
  }
}
