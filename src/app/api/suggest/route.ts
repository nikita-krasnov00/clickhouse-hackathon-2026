/**
 * GET /api/suggest — вопросы-пресеты для главной, сгенерированные быстрой
 * моделью по ЖИВОМУ каталогу таблиц (никаких захардкоженных примеров: что
 * лежит в ClickHouse — про то и подсказки).
 *
 * Ответ 200: строго suggestResponseSchema { questions } — пустой массив
 * валиден и означает «пресетов нет» (LLM/ClickHouse недоступны); UI в этом
 * случае просто не рисует чипы. Кэш в памяти процесса на SUGGEST_TTL_MS —
 * пресеты не обязаны быть свежее каталога.
 */
import { NextResponse } from "next/server";
import { suggestResponseSchema } from "@/lib/contracts";
import { createReadonlyClient } from "@/lib/clickhouse";
import { getCatalog } from "@/lib/agent/explore";
import { suggestQuestions } from "@/lib/agent/triage";

// Node.js runtime: ClickHouse-клиент и OpenRouter ходят наружу с кредами из env.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUGGEST_TTL_MS = 10 * 60_000;

let cache: { questions: string[]; at: number } | undefined;

export async function GET() {
  if (cache && Date.now() - cache.at < SUGGEST_TTL_MS) {
    return NextResponse.json(suggestResponseSchema.parse({ questions: cache.questions }));
  }
  const ro = createReadonlyClient();
  try {
    const catalog = await getCatalog(ro);
    const questions = await suggestQuestions(catalog);
    cache = { questions, at: Date.now() };
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
