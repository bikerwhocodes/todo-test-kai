import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "@/components/auth/login-form";
import { safeNextPath } from "@/lib/safe-redirect";

export const metadata: Metadata = { title: "Log in · NextUp" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const nextPath = safeNextPath(Array.isArray(next) ? next[0] : next);
  return (
    <>
      <h1 className="mb-6 text-lg font-medium">Log in</h1>
      <LoginForm next={nextPath} />
      <p className="mt-6 text-sm text-stone-600">
        New to NextUp?{" "}
        <Link className="font-medium text-stone-900 underline" href="/signup">
          Create an account
        </Link>
      </p>
    </>
  );
}
