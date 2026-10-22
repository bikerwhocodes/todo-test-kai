import { redirect } from "next/navigation";
import { requireUser } from "@/server/session";

export default async function Home() {
  await requireUser();
  redirect("/today");
}
