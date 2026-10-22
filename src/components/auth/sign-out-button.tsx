import { signOutAction } from "@/server/actions/auth";
import { focusRingClass } from "@/components/ui";

export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <button type="submit" className={`rounded-md px-2 py-1 hover:bg-stone-200 hover:text-stone-900 ${focusRingClass}`}>
        Log out
      </button>
    </form>
  );
}
