"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { shouldFocusSearch, type ShortcutTarget } from "@/core/search";

const SEARCH_INPUT_ID = "search-input";

function describe(target: EventTarget | null): ShortcutTarget | null {
  if (!(target instanceof HTMLElement)) return null;
  return {
    tagName: target.tagName,
    type: target instanceof HTMLInputElement ? target.type : undefined,
    isContentEditable: target.isContentEditable,
    inDialog: target.closest('dialog[open], [role="dialog"], [aria-modal="true"]') !== null,
  };
}

/** "/" anywhere in the app focuses the search box, or opens /search (which autofocuses it). Renders nothing. */
export function SearchShortcut() {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!shouldFocusSearch(event, describe(event.target))) return;
      event.preventDefault();
      const input = document.getElementById(SEARCH_INPUT_ID);
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
      } else {
        router.push("/search");
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return null;
}
