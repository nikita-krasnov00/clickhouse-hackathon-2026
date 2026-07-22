/**
 * NextAuth routes: /api/auth/* — signin, callback/google, signout, session.
 * All logic lives in src/auth.ts; this file only exports handlers.
 */
import { handlers } from "@/auth";

export const runtime = "nodejs";
export const { GET, POST } = handlers;
