/**
 * Бейдж пользователя в шапке: аватар Google, email, «Выйти» (server action
 * NextAuth). Серверный компонент; страницы и так за гейтом proxy.ts, поэтому
 * без сессии просто ничего не рендерит.
 */
import Image from "next/image";
import { auth, signOut } from "@/auth";

export async function UserBadge() {
  const session = await auth();
  const user = session?.user;
  if (!user) return null;

  return (
    <div className="flex items-center gap-3">
      {user.image && (
        <Image
          src={user.image}
          alt=""
          width={24}
          height={24}
          className="rounded-full"
        />
      )}
      <span className="hidden text-xs text-muted sm:inline">{user.email}</span>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
      >
        <button
          type="submit"
          className="rounded-full border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/60 hover:text-foreground"
        >
          Выйти
        </button>
      </form>
    </div>
  );
}
