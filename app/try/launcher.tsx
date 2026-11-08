"use client";
import { useEffect, useRef, useState } from "react";

type State = { kind: "code"; error?: string } | { kind: "starting" } | { kind: "failed"; message: string };

const box: React.CSSProperties = { maxWidth: 440, width: "100%", textAlign: "center" };
const title: React.CSSProperties = { fontSize: 22, fontWeight: 500, marginBottom: 12 };
const muted: React.CSSProperties = { color: "var(--site-muted)" };
const button = "bg-[var(--site-accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60";

/** Starts the user's sandbox and moves this tab into the app; asks for the invitation code once. */
export default function TryLauncher({ needsCode }: { needsCode: boolean }) {
  const [state, setState] = useState<State>(needsCode ? { kind: "code" } : { kind: "starting" });
  const [code, setCode] = useState("");
  const started = useRef(false);

  const start = async (withCode?: string) => {
    setState({ kind: "starting" });
    try {
      const r = await fetch("/api/try", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(withCode ? { code: withCode } : {}) });
      const body = (await r.json().catch(() => ({}))) as { url?: string; error?: string; message?: string };
      if (r.status === 403 && (body.error === "code_required" || body.error === "invalid_code")) {
        setState({ kind: "code", error: body.error === "invalid_code" ? body.message : undefined });
        return;
      }
      if (r.status === 401) {
        window.location.assign("/account?returnTo=" + encodeURIComponent("https://humanstudy-hub.com/try"));
        return;
      }
      if (!r.ok || !body.url) throw new Error(body.message || "HumanStudy Hub could not start. Please try again.");
      window.location.replace(body.url);
    } catch (e) {
      setState({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  };

  useEffect(() => {
    if (needsCode || started.current) return;
    started.current = true;
    void start();
  }, [needsCode]);

  return (
    <main style={{ minHeight: "60vh", display: "grid", placeItems: "center", padding: "48px 16px" }}>
      <div style={box}>
        {state.kind === "code" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) void start(code.trim());
            }}
          >
            <h1 style={title}>HumanStudy Hub online</h1>
            <p style={{ ...muted, marginBottom: 20 }}>The app runs in a workspace of your own. Enter your invitation code to open it.</p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-label="Invitation code"
              placeholder="Invitation code"
              autoComplete="off"
              autoFocus
              className="mb-3 w-full border border-[var(--site-line)] bg-[var(--background)] px-3 py-2.5 text-sm"
            />
            {state.error && <p style={{ color: "var(--warning, #8a6020)", marginBottom: 12 }}>{state.error}</p>}
            <button type="submit" className={button} disabled={!code.trim()}>
              Open HumanStudy Hub
            </button>
          </form>
        )}
        {state.kind === "starting" && (
          <>
            <h1 style={title}>Opening HumanStudy Hub…</h1>
            <p style={muted}>Your workspace is starting. This takes up to half a minute.</p>
          </>
        )}
        {state.kind === "failed" && (
          <>
            <h1 style={title}>HumanStudy Hub did not open</h1>
            <p style={{ ...muted, marginBottom: 20 }}>{state.message}</p>
            <button type="button" onClick={() => void start()} className={button}>
              Try again
            </button>
          </>
        )}
      </div>
    </main>
  );
}
