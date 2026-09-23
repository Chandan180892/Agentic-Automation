import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-ground px-6 text-center">
      <div className="grid gap-3">
        <h1 className="text-[20px]">Not found</h1>
        <p className="text-[13px] text-muted">That page does not exist, or it belongs to a workspace you are not in.</p>
        <Link href="/sprint" className="text-[13px] font-semibold text-accent hover:underline">
          Back to your sprint
        </Link>
      </div>
    </main>
  );
}
