import { redirect } from "next/navigation";
import { getSession } from "@/server/session";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await getSession()) redirect("/today");
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center text-2xl font-semibold tracking-tight">NextUp</p>
        {children}
      </div>
    </main>
  );
}
