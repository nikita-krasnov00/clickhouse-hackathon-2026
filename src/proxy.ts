/**
 * Гейт аутентификации на всё приложение (proxy — бывший middleware Next).
 * Без сессии: страницы → редирект на /login с возвратом, API → 401 JSON.
 * Открыты только /login, роуты NextAuth (/api/auth/*) и статика — см. matcher.
 */
import type {
  NextFetchEvent,
  NextMiddleware,
  NextRequest,
} from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/auth";

// Обёртка auth() читает JWT-cookie и кладёт сессию в req.auth.
// Три обхода поверх канонного `export default auth(…)` (next-auth beta.32,
// версия запинена):
// 1) Next 16 принимает только статически видимую функцию proxy/default;
// 2) при ленивом NextAuth(() => …) auth(fn) в рантайме отдаёт
//    Promise<middleware>, хотя типы обещают функцию — нужен await;
// 3) TS матчит вызов на перегрузку route-handler'а — приводим к
//    фактическому Promise<NextMiddleware>.
const gate = auth((req) => {
  if (req.auth) return NextResponse.next();

  const { nextUrl } = req;
  if (nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Не авторизован — войдите через Google" },
      { status: 401 },
    );
  }
  const login = new URL("/login", nextUrl);
  login.searchParams.set("callbackUrl", nextUrl.pathname + nextUrl.search);
  return NextResponse.redirect(login);
}) as unknown as Promise<NextMiddleware>;

export default async function proxy(req: NextRequest, event: NextFetchEvent) {
  return (await gate)(req, event);
}

export const config = {
  matcher: [
    "/((?!login|api/auth|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
