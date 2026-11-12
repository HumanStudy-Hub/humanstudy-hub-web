"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { TRY_SIGN_IN } from "@/lib/try-online-config";
import styles from "@/components/folio-page.module.css";

type Workspace = "new" | "running" | "stopped" | "transition";
type Phase = "idle" | "starting" | "stopping" | "cancelling";
type Reply = { status?: Workspace; url?: string; error?: string; message?: string; pending?: boolean };

export default function TryLauncher({ needsCode, sessionMinutes }: { needsCode: boolean; sessionMinutes: number }) {
  const [codeRequired, setCodeRequired] = useState(needsCode);
  const [code, setCode] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  const stopRequested = useRef(false);
  const activeAttempt = useRef<string | null>(null);
  const actionRevision = useRef(0);

  async function checkStatus(signal?: AbortSignal) {
    const revision = actionRevision.current;
    try {
      const response = await fetch("/api/try", { cache: "no-store", signal });
      if (response.status === 401) return;
      const data = await response.json() as Reply;
      if (revision !== actionRevision.current || signal?.aborted) return;
      if (!response.ok || !data.status) throw Error(data.message || "Could not check your workspace status.");
      setWorkspace(data.status);
      if (data.status !== "running") setUrl("");
      if (data.status === "stopped" || data.status === "new") setPhase(current => current === "cancelling" ? "idle" : current);
    } catch (error) {
      if (revision === actionRevision.current && !signal?.aborted) setMessage(error instanceof Error ? error.message : "Could not check your workspace status.");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void checkStatus(controller.signal);
    return () => controller.abort();
  }, []);

  async function start() {
    actionRevision.current++;
    setPhase("starting");
    setMessage("");
    stopRequested.current = false;
    const attempt = crypto.randomUUID();
    activeAttempt.current = attempt;
    try {
      const response = await fetch("/api/try", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attempt, ...(codeRequired ? { code: code.trim() } : {}) }),
      });
      const data = await response.json().catch(() => ({})) as Reply;
      if (response.status === 401) {
        window.location.assign(TRY_SIGN_IN);
        return;
      }
      if (response.status === 403 && ["code_required", "invalid_code"].includes(data.error || "")) setCodeRequired(true);
      if (data.error === "workspace_cancelled") {
        setWorkspace("stopped");
        setMessage("Startup was cancelled.");
        setPhase("idle");
        return;
      }
      if (!response.ok || !data.url) throw Error(data.message || "Could not open the workspace. Please try again.");
      setCodeRequired(false);
      setCode("");
      if (!stopRequested.current) {
        setWorkspace("running");
        setUrl(data.url);
        setPhase("idle");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open the workspace.");
      setPhase("idle");
    } finally {
      if (activeAttempt.current === attempt) activeAttempt.current = null;
    }
  }

  async function stop() {
    actionRevision.current++;
    stopRequested.current = true;
    setPhase("stopping");
    setUrl("");
    setMessage("");
    try {
      const attempt = activeAttempt.current;
      const response = await fetch("/api/try", {
        method: "DELETE",
        ...(attempt ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attempt }) } : {}),
      });
      const data = await response.json().catch(() => ({})) as Reply;
      if (response.status === 401) {
        window.location.assign(TRY_SIGN_IN);
        return;
      }
      if (!response.ok) throw Error(data.message || "Could not stop the workspace. Please try again.");
      if (data.pending) {
        setPhase(activeAttempt.current || !attempt ? "cancelling" : "idle");
        return;
      }
      setWorkspace("stopped");
      setMessage("Workspace stopped. Resume it when you are ready.");
    } catch (error) {
      stopRequested.current = false;
      setMessage(error instanceof Error ? error.message : "Could not stop the workspace.");
    }
    setPhase("idle");
  }

  const busy = phase !== "idle";
  const action = workspace === "stopped" ? "Resume workspace" : workspace === "running" ? "Reconnect to workspace" : "Start workspace";
  return (
    <div className={`${styles.page} ${styles.narrow}`}>
      <h1>HumanStudy Hub online</h1>
      <p className={styles.lede}>Open the desktop workspace in your browser. Sessions last up to {sessionMinutes} minutes.</p>
      <div className={styles.section}>
        {phase === "starting" && <p role="status">Opening your workspace…</p>}
        {phase === "stopping" && <p role="status">Stopping your workspace…</p>}
        {phase === "cancelling" && <p role="status">Cancellation requested. The workspace will stop once startup finishes.</p>}
        {message && <p role="status" className="mb-4">{message}</p>}
        {url && <p className="mb-4"><a href={url} target="_blank" rel="noreferrer" className={styles.button}>Open in browser ↗</a></p>}
        {!busy && !url && <form onSubmit={event => { event.preventDefault(); void start(); }} className="mb-4">
          {codeRequired && <label className="mb-3 block">
            <span className="block">Invitation code</span>
            <input value={code} onChange={event => setCode(event.target.value)} autoComplete="off"
              className="mt-1 max-w-full border border-[var(--site-line)] bg-[var(--background)] px-3 py-2" />
          </label>}
          <button className={styles.button} disabled={codeRequired && !code.trim()}>{action}</button>
        </form>}
        {(phase === "starting" || phase === "cancelling" || (!busy && (workspace === "running" || workspace === "transition"))) &&
          <button type="button" className="mr-4 underline" onClick={() => void stop()}>{phase === "starting" ? "Cancel startup" : phase === "cancelling" ? "Retry stop" : "Stop workspace"}</button>}
        {(!busy || phase === "cancelling") && <button type="button" className="mr-4 underline" onClick={() => { setMessage(""); void checkStatus(); }}>Check status</button>}
        <Link href="/download" className="underline">Desktop app</Link>
      </div>
    </div>
  );
}
