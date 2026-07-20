/**
 * Общий слой «строгий JSON от модели»: выделение JSON-объекта из ответа
 * (срезание reasoning-блоков и markdown-фенсов) и диалог со страховкой
 * парсинга — один повторный запрос с текстом ошибки, дальше исключение.
 * Используется и планировщиком SQL (generate-sql.ts), и триажем (triage.ts).
 */
import { chatComplete, type ChatCompleteOptions, type ChatMessage } from "./llm";

/** Срезает reasoning-блоки и markdown-фенсы, выделяет JSON-объект. */
export function extractJsonObject(content: string): string {
  let text = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  text = text.replace(/```(?:json)?/gi, "").trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) {
    throw new Error("в ответе модели нет JSON-объекта");
  }
  return text.slice(first, last + 1);
}

/**
 * Диалог с моделью со страховкой парсинга: при невалидном JSON — один повторный
 * запрос с текстом ошибки, дальше — исключение (его ловит вызывающий).
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
