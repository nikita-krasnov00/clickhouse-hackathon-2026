/**
 * Роуты NextAuth: /api/auth/* — signin, callback/google, signout, session.
 * Вся логика в src/auth.ts, здесь только экспорт хендлеров.
 */
import { handlers } from "@/auth";

export const runtime = "nodejs";
export const { GET, POST } = handlers;
