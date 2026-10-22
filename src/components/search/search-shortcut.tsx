"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { shouldFocusSearch } from "@/core/search";
import { describeTarget } from "@/components/keyboard/target";

const SEARCH_INPUT_ID = "search-input";

/** "/" anywhere in the app focuses the search box, or opens /search (which autofocuses it). Renders nothing. */
export function SearchShortcut() {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!shouldFocusSearch(event, describeTarget(event.target))) return;
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
