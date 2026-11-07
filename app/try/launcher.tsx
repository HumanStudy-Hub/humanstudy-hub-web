"use client";
import { useEffect, useRef, useState } from "react";
import styles from "@/components/folio-page.module.css";

type State = { kind: "starting" } | { kind: "failed"; message: string };

/** Starts the user's sandbox and moves this tab into the app. */
export default function TryLauncher() {
  const [state, setState] = useState<State>({ kind: "starting" });
  const started = useRef(false);
  const start = async () => {
    setState({ kind: "starting" });
    try {
      const r = await fetch("/api/try", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = (await r.json().catch(() => ({}))) as { url?: string; message?: string };
      if (!r.ok || !body.url) throw new Error(body.message || "HumanStudy Hub could not start. Please try again.");
      window.location.replace(body.url);
    } catch (e) {
      setState({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, []);
  return (
    <main className={styles.page ?? ""} style={{ minHeight: "60vh", display: "grid", placeItems: "center", padding: "48px 16px" }}>
      <div style={{ maxWidth: 440, textAlign: "center" }}>
        {state.kind === "starting" ? (
          <>
            <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 12 }}>Opening HumanStudy Hub…</h1>
            <p style={{ color: "var(--site-muted)" }}>Your own workspace is starting. This takes about half a minute the first time.</p>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 12 }}>HumanStudy Hub did not open</h1>
            <p style={{ color: "var(--site-muted)", marginBottom: 20 }}>{state.message}</p>
            <button type="button" onClick={() => void start()} className="bg-[var(--site-accent)] px-4 py-2.5 text-sm font-semibold text-white">
              Try again
            </button>
          </>
        )}
      </div>
    </main>
  );
}
