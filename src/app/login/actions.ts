"use server";

import { redirect } from "next/navigation";
import { signIn, signOut } from "@/auth";

export async function signInWith(provider: string, callbackUrl = "/sprint") {
  await signIn(provider, { redirectTo: callbackUrl });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}

export async function demoSignInAction() {
  const { signInAsDemo } = await import("@/lib/demo");
  await signInAsDemo();
  redirect("/sprint");
}
