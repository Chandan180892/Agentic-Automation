"use client";

import { useState } from "react";
import { Button, Label } from "@/components/ui";

export function TokenReveal({ token, name }: { token: string; name: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const command = `npx @gantry/runner connect \\\n  --url ${typeof window !== "undefined" ? window.location.origin : ""} \\\n  --token ${token} \\\n  --name ${name} --slots 2`;

  async function copy(what: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="mb-4 rounded-[10px] border border-accent-line bg-accent-soft p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-accent">Token for {name} — shown once</Label>
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => copy("token", token)}>
            {copied === "token" ? "Copied" : "Copy token"}
          </Button>
          <Button size="sm" variant="primary" onClick={() => copy("cmd", command.replace(/\\\n\s*/g, " "))}>
            {copied === "cmd" ? "Copied" : "Copy command"}
          </Button>
        </div>
      </div>
      <pre className="term term-text mt-3 overflow-x-auto rounded-lg px-3.5 py-3 font-mono text-[11.5px] leading-[1.7]">
        {command}
      </pre>
      <p className="mt-2.5 text-[11.5px] leading-[1.6] text-accent">
        Run that on the machine you want to execute specs. It dials out to Gantry over HTTPS and starts
        claiming jobs — no inbound port, no VPN, no SSH key held here. Store the token somewhere safe;
        this page will not show it again.
      </p>
    </div>
  );
}
