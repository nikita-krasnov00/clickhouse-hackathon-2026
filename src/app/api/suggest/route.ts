/**
 * GET /api/suggest — вопросы-пресеты для главной, сгенерированные быстрой
 * моделью по ЖИВОМУ каталогу таблиц (никаких захардкоженных примеров: что
 * лежит в ClickHouse — про то и подсказки).
 *
 * Локаль UI (cookie NEXT_LOCALE / Accept-Language) задаёт язык пресетов —
 * промпт suggestQuestions просит вопросы на языке интерфейса.
 *
 * Ответ 200: строго suggestResponseSchema { questions } — пустой массив
 * валиден и означает «пресетов нет» (LLM/ClickHouse недоступны); UI в этом
 * случае просто не рисует чипы. Кэш в памяти процесса ПО ЛОКАЛИ на
 * SUGGEST_TTL_MS — пресеты не обязаны быть свежее каталога.
 */
import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { suggestResponseSchema } from "@/lib/contracts";
import { createReadonlyClient } from "@/lib/clickhouse";
import { getCatalog } from "@/lib/agent/explore";
import { suggestQuestions } from "@/lib/agent/triage";
import {
  LOCALE_COOKIE,
  LOCALE_ENGLISH_NAME,
  negotiateLocale,
  type Locale,
} from "@/lib/i18n/locale";

// Node.js runtime: ClickHouse-клиент и OpenRouter ходят наружу с кредами из env.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUGGEST_TTL_MS = 10 * 60_000;

const cache = new Map<Locale, { questions: string[]; at: number }>();

export async function GET() {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = negotiateLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get("accept-language"),
  );

  const cached = cache.get(locale);
  if (cached && Date.now() - cached.at < SUGGEST_TTL_MS) {
    return NextResponse.json(suggestResponseSchema.parse({ questions: cached.questions }));
  }
  const ro = createReadonlyClient();
  try {
    const catalog = await getCatalog(ro);
    const questions = await suggestQuestions(catalog, LOCALE_ENGLISH_NAME[locale]);
    cache.set(locale, { questions, at: Date.now() });
    return NextResponse.json(suggestResponseSchema.parse({ questions }));
  } catch (err) {
    // Пресеты некритичны: любой сбой — валидный пустой ответ, не 5xx.
    console.warn(
      `/api/suggest: фоллбек на пустые пресеты — ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json(suggestResponseSchema.parse({ questions: [] }));
  } finally {
    await ro.close();
  }
}
