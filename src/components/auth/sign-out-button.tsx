import { signOutAction } from "@/server/actions/auth";

export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <button type="submit" className="rounded-md px-2 py-1 hover:bg-stone-200 hover:text-stone-900">
        Log out
      </button>
    </form>
  );
}
