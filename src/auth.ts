/**
 * Frontend authentication: Google sign-in (NextAuth v5, JWT sessions).
 *
 * The public deploy stays a single link for judges, but /api/ask can no
 * longer be called anonymously (LLM tokens, ClickHouse). The session is a
 * signed JWT in an httpOnly cookie; no database required. AUTH_ALLOWED_EMAILS
 * restricts sign-in to a list; an empty list allows any Google account.
 *
 * Lazy config (as a function): env is validated on the first request,
 * not during next build — the build succeeds without secrets.
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
      // Google provides email_verified; reject unverified emails.
      if (!email || profile?.email_verified === false) return false;
      const allowed = config.auth.allowedEmails;
      return allowed.length === 0 || allowed.includes(email);
    },
  },
}));
