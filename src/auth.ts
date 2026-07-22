/**
 * Аутентификация фронтенда: вход через Google (NextAuth v5, JWT-сессии).
 *
 * Публичный деплой остаётся по одной ссылке для жюри, но /api/ask больше
 * нельзя дёргать анонимно (LLM-токены, ClickHouse). Сессия — подписанный
 * JWT в httpOnly-cookie, базы данных не требует. AUTH_ALLOWED_EMAILS
 * сужает вход до списка; пустой список — любой Google-аккаунт.
 *
 * Конфиг ленивый (функцией): env валидируются на первый запрос,
 * а не при next build — сборка без секретов не падает.
 */
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { config } from "@/lib/config";

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  secret: config.auth.secret,
  providers: [
    Google({
      clientId: config.auth.googleId,
      clientSecret: config.auth.googleSecret,
    }),
  ],
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    signIn({ profile }) {
      const email = profile?.email?.toLowerCase();
      // Google отдаёт email_verified; непроверенный email не пускаем.
      if (!email || profile?.email_verified === false) return false;
      const allowed = config.auth.allowedEmails;
      return allowed.length === 0 || allowed.includes(email);
    },
  },
}));
