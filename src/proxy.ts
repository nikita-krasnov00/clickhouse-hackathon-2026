/**
 * Authentication gate for the whole app (proxy — former Next middleware).
 * Without a session: pages → redirect to /login with return URL, API → 401 JSON.
 * Only /login, NextAuth routes (/api/auth/*), and static assets are open — see matcher.
 */
import type {
  NextFetchEvent,
  NextMiddleware,
  NextRequest,
} from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { apiMessage } from "@/lib/i18n/api-messages";
import { LOCALE_COOKIE, negotiateLocale } from "@/lib/i18n/locale";

// The auth() wrapper reads the JWT cookie and puts the session in req.auth.
// Three workarounds on top of the canonical `export default auth(…)` (next-auth beta.32,
// pinned version):
// 1) Next 16 accepts only a statically visible proxy/default function;
// 2) with lazy NextAuth(() => …), auth(fn) returns Promise<middleware> at runtime
//    although types promise a function — await is required;
// 3) TS matches the call to the route-handler overload — cast to the actual
//    Promise<NextMiddleware>.
const gate = auth((req) => {
  if (req.auth) return NextResponse.next();

  const { nextUrl } = req;
  if (nextUrl.pathname.startsWith("/api/")) {
    const locale = negotiateLocale(
      req.cookies.get(LOCALE_COOKIE)?.value,
      req.headers.get("accept-language"),
    );
    return NextResponse.json(
      { error: apiMessage(locale, "unauthorized") },
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
