import type { Metadata } from "next";
import Link from "next/link";
import { SignupForm } from "@/components/auth/signup-form";

export const metadata: Metadata = { title: "Sign up · NextUp" };

export default function SignupPage() {
  return (
    <>
      <h1 className="mb-6 text-lg font-medium">Create your account</h1>
      <SignupForm />
      <p className="mt-6 text-sm text-stone-600">
        Already have an account?{" "}
        <Link className="font-medium text-stone-900 underline" href="/login">
          Log in
        </Link>
      </p>
    </>
  );
}
