"use client";

import { useRef, useState } from "react";
import { Button, Label } from "@/components/ui";

export function AddStoryPanel({
  sprintId,
  action,
}: {
  sprintId: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Add story
      </Button>
    );
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      <form
        ref={form}
        action={async (fd) => {
          await action(fd);
          form.current?.reset();
          setOpen(false);
        }}
        className="order-last grid w-full gap-3 border-t border-line-soft pt-3.5"
      >
        <input type="hidden" name="sprintId" value={sprintId} />
        <div className="grid gap-3 sm:grid-cols-[140px_1fr_92px]">
          <label className="grid gap-1.5">
            <Label>Key</Label>
            <input
              name="key"
              required
              placeholder="PAY-900"
              className="rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px] uppercase outline-none focus:border-accent-line"
            />
          </label>
          <label className="grid gap-1.5">
            <Label>Title</Label>
            <input
              name="title"
              required
              placeholder="What the user gets"
              className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent-line"
            />
          </label>
          <label className="grid gap-1.5">
            <Label>Points</Label>
            <input
              name="points"
              type="number"
              min={0}
              placeholder="—"
              className="rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px] outline-none focus:border-accent-line"
            />
          </label>
        </div>
        <label className="grid gap-1.5">
          <Label>Description</Label>
          <textarea
            name="description"
            rows={2}
            placeholder="Context an engineer would need"
            className="resize-y rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent-line"
          />
        </label>
        <label className="grid gap-1.5">
          <Label>Acceptance criteria — one per line</Label>
          <textarea
            name="acceptanceCriteria"
            rows={3}
            placeholder={"Leave empty and sprint-planner will draft them for review."}
            className="resize-y rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent-line"
          />
        </label>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="sm">
            Add to backlog
          </Button>
        </div>
      </form>
    </>
  );
}
