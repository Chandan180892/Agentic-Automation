import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness: the process is up and serving. Deliberately touches nothing else. */
export function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
