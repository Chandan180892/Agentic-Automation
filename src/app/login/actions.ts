"use server";

import { signIn, signOut } from "@/auth";

export async function signInWith(provider: string, callbackUrl = "/sprint") {
  await signIn(provider, { redirectTo: callbackUrl });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
