import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireUser } from "@/server/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-4">
      <header className="flex items-center justify-between py-4">
        <span className="font-semibold tracking-tight">NextUp</span>
        <div className="flex items-center gap-3 text-sm text-stone-600">
          <span className="hidden sm:inline">{user.email}</span>
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1 py-6">{children}</main>
    </div>
  );
}
