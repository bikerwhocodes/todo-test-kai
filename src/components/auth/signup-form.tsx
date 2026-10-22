"use client";

import { useState } from "react";
import { DEFAULT_AFTER_LOGIN } from "@/lib/safe-redirect";
import { Field, FormError, SubmitButton } from "./field";
import { postAuth } from "./post-auth";

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function SignupForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await postAuth("/sign-up/email", {
      name: String(form.get("name") ?? "").trim(),
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      // Stored in user_settings by the signup hook; validated server-side (falls back to UTC).
      timeZone: browserTimeZone(),
    });
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }
    window.location.assign(DEFAULT_AFTER_LOGIN);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <FormError message={error} />
      <Field label="Name" name="name" autoComplete="name" required maxLength={100} />
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        maxLength={128}
      />
      <SubmitButton pending={pending}>{pending ? "Creating account…" : "Create account"}</SubmitButton>
    </form>
  );
}
