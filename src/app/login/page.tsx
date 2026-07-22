/**
 * Login page — the only page without a session (proxy.ts lets it through).
 * The button starts the Google OAuth flow via a NextAuth server action; after
 * sign-in, redirect to callbackUrl (internal path only, no open redirect).
 */
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, signIn } from "@/auth";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";

type Props = {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
};

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export default async function LoginPage({ searchParams }: Props) {
  const session = await auth();
  if (session) redirect("/");

  const t = await getTranslations("login");
  const { callbackUrl, error } = await searchParams;
  // Return only to an internal path ("//host" is external too — reject it).
  const redirectTo =
    callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//")
      ? callbackUrl
      : "/";

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-8 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Insight Desk</h1>
        <p className="mt-2 text-sm text-muted">{t("intro")}</p>
        {error === "AccessDenied" ? (
          <p className="mt-4 rounded-lg border border-[color:var(--viz-critical)]/40 bg-[color:var(--viz-critical)]/10 px-3 py-2 text-sm text-[color:var(--viz-critical)]">
            {t("accessDenied")}
          </p>
        ) : error ? (
          <p className="mt-4 rounded-lg border border-[color:var(--viz-warning)]/40 bg-[color:var(--viz-warning)]/10 px-3 py-2 text-sm text-[color:var(--viz-warning)]">
            {t("failed", { error })}
          </p>
        ) : null}
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo });
          }}
          className="mt-6"
        >
          <button
            type="submit"
            className="inline-flex w-full items-center justify-center gap-3 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-[#1f1f1f] transition-opacity hover:opacity-90"
          >
            <GoogleMark />
            {t("googleButton")}
          </button>
        </form>
        <div className="mt-6 flex justify-center">
          <LocaleSwitcher />
        </div>
      </div>
    </main>
  );
}
