"use client";

import { useState } from "react";

export default function CopyStudyId({ id }: { id: string }) {
  const [message, setMessage] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setMessage("Copied");
    } catch {
      setMessage("Select the study ID to copy it.");
    }
  }
  return <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
    <code className="select-all break-all">{id}</code>
    <button type="button" onClick={copy} className="cursor-pointer text-[var(--site-accent)] underline">Copy study ID</button>
    <span role="status" className="text-[var(--site-muted)]">{message}</span>
  </div>;
}
