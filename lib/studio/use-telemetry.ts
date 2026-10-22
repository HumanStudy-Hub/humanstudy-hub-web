"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioEvent } from "./types";

// Collection contract (HumanStudy-Hub/humanstudy-desktop#27): one primary event per user
// operation, scrolling summarized when it settles, and no pointer trajectories,
// keystrokes or continuous recordings.

type ExplicitEvent = Extract<StudioEvent["type"], "selection" | "chat" | "review" | "layout">;
type Metadata = StudioEvent["metadata"];
type TelemetryState = { droppedEvents: number; deliveryError: string | null };
type ScrollRun = { target?: string; start: number; end: number; max: number; startedAt: number; timer?: ReturnType<typeof setTimeout> };

// Events have no count/age pruning; storage failures are visible, never silent.
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 60_000;
export const SCROLL_SETTLE_MS = 800;
// The server rejects events older than 30 days; never resend those from storage.
// Browsers normally cap all outstanding keepalive bodies at about 64 KiB.
const KEEPALIVE_BUDGET = 60_000;
export const STORAGE_PREFIX = "hs-studio-telemetry:";
const METADATA_KEYS = new Set(["action", "area", "mode", "status", "sourceId", "conversationId", "entityId", "reviewId", "page", "count", "selectionLength", "button", "direction", "startDepth", "endDepth", "maxDepth"]);

function cleanMetadata(metadata?: Metadata): Metadata | undefined {
  if (!metadata) return undefined;
  const clean: NonNullable<Metadata> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 12)) {
    if (!METADATA_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000) clean[key] = value;
    else if (typeof value === "boolean") clean[key] = value;
    else if (typeof value === "string") {
      const safe = value.replace(/[^a-zA-Z0-9_.:/#-]/g, "").slice(0, 80);
      if (safe) clean[key] = safe;
    }
  }
  return Object.keys(clean).length ? clean : undefined;
}

function semanticTarget(target: EventTarget | null, root: Element): string | undefined {
  if (!(target instanceof Element) || !root.contains(target)) return undefined;
  const named = target.closest("[data-event]");
  if (named && root.contains(named)) {
    const name = named.getAttribute("data-event")?.toLowerCase().replace(/[^a-z0-9_.:-]/g, "").slice(0, 80);
    if (name) return name;
  }
  const element = target.closest("button,a,input,select,textarea,[role]") ?? target;
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role")?.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  return role ? `${tag}[role-${role}]` : tag;
}

/** Scroll position as per-mille of the scrollable range (0 = top, 1000 = bottom). */
function depth(element: Element): number | undefined {
  const range = element.scrollHeight - element.clientHeight;
  if (range <= 0) return undefined;
  return Math.round(Math.max(0, Math.min(1, element.scrollTop / range)) * 1000);
}

// Where each container's last scroll settled, so the next summary starts from there.
const settledDepth = new WeakMap<Element, number>();

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function isStoredEvent(value: unknown): value is StudioEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<StudioEvent>;
  if (typeof event.id !== "string" || typeof event.sessionId !== "string" || typeof event.type !== "string" || typeof event.at !== "string") return false;
  const at = Date.parse(event.at);
  return event.type !== ("pointer" as string) && Number.isFinite(at);
}

/** Take over events that earlier pages (or remounts) left undelivered for this workspace. */
function adoptStored(workspaceId: string, ownKey: string): StudioEvent[] {
  const store = storage();
  if (!store) return [];
  const adopted: StudioEvent[] = [];
  try {
    const prefix = `${STORAGE_PREFIX}${workspaceId}:`;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(prefix) && key !== ownKey) keys.push(key);
    }
    const seen = new Set<string>();
    for (const key of keys) {
      if (key.includes(':rejected:')) continue;
      try {
        const parsed: unknown = JSON.parse(store.getItem(key) || "[]");
        const values = Array.isArray(parsed) ? parsed : [parsed];
        for (const event of values) if (isStoredEvent(event) && !seen.has(event.id)) { seen.add(event.id); adopted.push(event); }
      } catch { /* retain corrupt data for recovery; never delete on adoption */ }
    }
  } catch { return adopted; }
  return adopted;
}

export function useStudioTelemetry({ workspaceId, enabled, surfaceVersion, workspaceRevision }: { workspaceId?: string; enabled: boolean; surfaceVersion?: number | string; workspaceRevision?: number }): {
  track: (type: ExplicitEvent, metadata?: Metadata) => void;
  droppedEvents: number;
  deliveryError: string | null;
} {
  const [state, setState] = useState<TelemetryState>({ droppedEvents: 0, deliveryError: null });
  const trackRef = useRef<((type: ExplicitEvent, metadata?: Metadata) => void) | null>(null);
  const sessionIdRef = useRef("");
  const installIdRef = useRef("");
  const seqRef = useRef(0);
  const revisionRef = useRef(workspaceRevision);
  useEffect(() => { revisionRef.current = workspaceRevision; }, [workspaceRevision]);

  const track = useCallback((type: ExplicitEvent, metadata?: Metadata) => {
    trackRef.current?.(type, cleanMetadata(metadata));
  }, []);

  useEffect(() => {
    if (!enabled || !workspaceId || typeof document === "undefined") return;
    const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-studio-workspace]"));
    const root = roots.find((element) => element.getAttribute("data-studio-workspace") === workspaceId)
      ?? roots.find((element) => !element.getAttribute("data-studio-workspace"));
    if (!root) return;

    if (!sessionIdRef.current) sessionIdRef.current = crypto.randomUUID();
    if (!installIdRef.current) installIdRef.current = crypto.randomUUID();
    const endpoint = `/api/studio/workspaces/${encodeURIComponent(workspaceId)}/events`;
    // One key per listener binding: a remount adopts (and removes) the previous binding's key.
    const storageKey = `${STORAGE_PREFIX}${workspaceId}:${crypto.randomUUID()}`;
    // Every undelivered event, including those in flight; removed by id only on success.
    const queue: StudioEvent[] = adoptStored(workspaceId, storageKey);
    let stopped = false;
    let sending = false;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    let clickTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingClick: StudioEvent | null = null;
    let visibleSince = document.visibilityState === "visible" ? Date.now() : 0;
    let requestController: AbortController | null = null;
    const scrollRuns = new Map<Element, ScrollRun>();

    /** Returns whether the pending queue is now durable in storage. */
    const persistNow = (): boolean => {
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = undefined; }
      const store = storage();
      if (!store) return false;
      try {
        // One independently addressed record per id. Tabs never rewrite or take ownership of
        // another tab's active queue. Acknowledgement deletes only confirmed ids.
        for (const event of queue) store.setItem(`${STORAGE_PREFIX}${workspaceId}:event:${event.id}`, JSON.stringify(event));
        return true;
      } catch { return false; /* quota or privacy mode: the in-memory queue still delivers */ }
    };
    const remove = (sent: StudioEvent[]) => {
      const ids = new Set(sent.map((event) => event.id));
      for (let i = queue.length - 1; i >= 0; i--) if (ids.has(queue[i].id)) queue.splice(i, 1);
      const store = storage();
      if (store) try {
        for (const id of ids) store.removeItem(`${STORAGE_PREFIX}${workspaceId}:event:${id}`);
        // Compatibility with saved pre-v1 arrays: remove acknowledged ids, never whole queues.
        const keys = Array.from({ length: store.length }, (_, i) => store.key(i)).filter((k): k is string => Boolean(k?.startsWith(`${STORAGE_PREFIX}${workspaceId}:`) && !k.includes(':event:') && !k.includes(':rejected:')));
        for (const key of keys) {
          const parsed: unknown = JSON.parse(store.getItem(key) || '[]');
          if (!Array.isArray(parsed)) continue;
          const left = parsed.filter(e => !ids.has(e.id));
          if (left.length) store.setItem(key, JSON.stringify(left)); else store.removeItem(key);
        }
      } catch { /* duplicate retry is harmless; a failed deletion never loses unacknowledged data */ }
    };
    const makeEvent = (type: StudioEvent["type"], fields: Partial<StudioEvent> = {}): StudioEvent => ({
      id: crypto.randomUUID(),
      sessionId: sessionIdRef.current,
      type,
      ...(revisionRef.current === undefined ? {} : { displayRevision: revisionRef.current }),
      at: new Date().toISOString(),
      ...fields,
    });
    const push = (event: StudioEvent) => {
      if (stopped) return;
      event.research ??= { installId: installIdRef.current, seq: ++seqRef.current };
      queue.push(event);
      const store = storage();
      try {
        if (!store) throw new Error('unavailable');
        store.setItem(`${STORAGE_PREFIX}${workspaceId}:event:${event.id}`, JSON.stringify(event));
      } catch { setState(previous => ({ ...previous, deliveryError: 'Local research storage is unavailable. Keep this page open until delivery succeeds.' })); }
      if (queue.length >= BATCH_SIZE) void flush();
    };
    const enqueue = (type: StudioEvent["type"], fields: Partial<StudioEvent> = {}) => push(makeEvent(type, fields));

    const flush = async () => {
      if (stopped || sending || !queue.length || retryTimer) return;
      sending = true;
      const batch = queue.slice(0, BATCH_SIZE);
      const controller = new AbortController();
      requestController = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      let retryable = true;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events: batch }),
          keepalive: true,
          signal: controller.signal,
        });
        if (!response.ok) {
          // Auth expiry and server trouble are transient; other 4xx mean the batch itself is invalid.
          retryable = response.status === 401 || response.status === 403 || response.status === 408 || response.status === 429 || response.status >= 500;
          throw new Error(`HTTP ${response.status}`);
        }
        remove(batch);
        retryCount = 0;
        setState((previous) => previous.deliveryError ? { ...previous, deliveryError: null } : previous);
      } catch {
        if (!stopped) {
          if (!retryable) {
            // A whole batch must never be discarded because one event failed. Isolate the bad
            // record by retrying individually; preserve complete rejected records for recovery.
            try { for (const event of batch) {
              const single = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [event] }) });
              if (single.ok) remove([event]);
              else if ([400, 413, 422].includes(single.status)) {
                const store = storage();
                if (!store) throw new Error('Cannot retain a rejected event.');
                store.setItem(`${STORAGE_PREFIX}${workspaceId}:rejected:${event.id}`, JSON.stringify({ event, status: single.status }));
                remove([event]);
              } else throw new Error('Delivery needs retry.');
            } } catch {
              retryCount++;
              retryTimer = setTimeout(() => { retryTimer = undefined; void flush(); }, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(16, retryCount - 1)));
            }
            setState((previous) => ({ ...previous, deliveryError: 'A rejected research record was retained locally for review.' }));
          } else {
            retryCount++;
            setState((previous) => ({ ...previous, deliveryError: "Telemetry delivery is retrying." }));
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              void flush();
            }, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(16, retryCount - 1)));
          }
        }
      } finally {
        clearTimeout(timeout);
        requestController = null;
        sending = false;
        if (!stopped && queue.length && !retryTimer) void flush();
      }
    };

    // Unload/hide path: persist first, then hand bounded keepalive requests to the browser.
    // Anything not confirmed stays in storage and is resent (idempotently, by id) next time.
    const sendFinal = (events: StudioEvent[], onDelivered: (batch: StudioEvent[]) => void) => {
      let bytes = 0;
      for (let offset = 0; offset < events.length; offset += BATCH_SIZE) {
        const batch = events.slice(offset, offset + BATCH_SIZE);
        const body = JSON.stringify({ events: batch });
        if (bytes + body.length > KEEPALIVE_BUDGET) break;
        bytes += body.length;
        try {
          void fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true })
            .then((response) => { if (response.ok) onDelivered(batch); })
            .catch(() => undefined);
        } catch { break; }
      }
    };
    const persistAndSend = () => {
      persistNow();
      sendFinal([...queue], remove);
    };

    const emitPendingClick = () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = undefined; }
      const click = pendingClick;
      pendingClick = null;
      if (click) push(click);
    };
    trackRef.current = (type, metadata) => {
      // A semantic handler that runs for the same click owns it: one operation, one primary event.
      const click = pendingClick;
      if (click) { pendingClick = null; if (clickTimer) { clearTimeout(clickTimer); clickTimer = undefined; } }
      enqueue(type, { ...(click?.target ? { target: click.target } : {}), ...(metadata ? { metadata } : {}) });
    };

    const onClick = (event: MouseEvent) => {
      const target = semanticTarget(event.target, root);
      if (!target) return;
      emitPendingClick();
      // React's semantic handlers run later in this same dispatch; wait one task for them.
      pendingClick = makeEvent("click", { target });
      clickTimer = setTimeout(emitPendingClick, 0);
    };

    const endScroll = (element: Element, status: string) => {
      const run = scrollRuns.get(element);
      if (!run) return;
      if (run.timer) clearTimeout(run.timer);
      scrollRuns.delete(element);
      settledDepth.set(element, run.end);
      if (run.start === run.end && run.max === run.start) return;
      enqueue("scroll", {
        ...(run.target ? { target: run.target } : {}),
        durationMs: Math.min(86_400_000, Math.max(0, Date.now() - run.startedAt)),
        metadata: { status, startDepth: run.start, endDepth: run.end, maxDepth: run.max },
      });
    };
    const endAllScrolls = (status: string) => { for (const element of [...scrollRuns.keys()]) endScroll(element, status); };
    const onScroll = (event: Event) => {
      const element = event.target;
      if (!(element instanceof Element) || !root.contains(element)) return;
      const position = depth(element);
      if (position === undefined) return;
      let run = scrollRuns.get(element);
      if (!run) {
        // The first event already reflects the new position; start from where it settled last.
        const start = settledDepth.get(element) ?? position;
        run = { target: semanticTarget(element, root), start, end: position, max: Math.max(start, position), startedAt: Date.now() };
        scrollRuns.set(element, run);
      }
      run.end = position;
      run.max = Math.max(run.max, position);
      if (run.timer) clearTimeout(run.timer);
      run.timer = setTimeout(() => {
        endScroll(element, "settled");
      }, SCROLL_SETTLE_MS);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        emitPendingClick();
        endAllScrolls("hidden");
        enqueue("visibility", { durationMs: visibleSince ? Math.min(86_400_000, Date.now() - visibleSince) : 0, metadata: { status: "hidden" } });
        visibleSince = 0;
        persistAndSend();
      } else {
        visibleSince = Date.now();
        enqueue("visibility", { metadata: { status: "visible" } });
        void flush();
      }
    };
    const onPageHide = () => {
      emitPendingClick();
      endAllScrolls("unload");
      if (visibleSince) {
        enqueue("visibility", { durationMs: Math.min(86_400_000, Date.now() - visibleSince), metadata: { status: "hidden" } });
        visibleSince = 0;
      }
      persistAndSend();
    };

    root.addEventListener("click", onClick);
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    const interval = setInterval(() => { if (document.visibilityState === "visible") void flush(); }, FLUSH_INTERVAL_MS);
    const adoptedCount = queue.length;
    if (visibleSince) enqueue("visibility", { metadata: { status: "visible" } });
    if (adoptedCount) { persistNow(); void flush(); }

    return () => {
      emitPendingClick();
      endAllScrolls("view");
      if (visibleSince) enqueue("visibility", { durationMs: Math.min(86_400_000, Date.now() - visibleSince), metadata: { status: "hidden" } });
      const durable = persistNow();
      const pending = [...queue];
      stopped = true;
      trackRef.current = null;
      root.removeEventListener("click", onClick);
      root.removeEventListener("scroll", onScroll, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      clearInterval(interval);
      if (retryTimer) clearTimeout(retryTimer);
      if (persistTimer) clearTimeout(persistTimer);
      requestController?.abort();
      if (!pending.length) return;
      if (!durable) { sendFinal(pending, () => undefined); return; }
      // A keyed remount adopts the stored queue in this same commit. If nothing adopted it
      // (the studio really unmounted), deliver it now; whatever fails stays for the next visit.
      setTimeout(() => {
        const store = storage();
        if (!store) return;
        sendFinal(pending, (batch) => {
          remove(batch);
        });
      }, 0);
    };
  }, [enabled, workspaceId, surfaceVersion]);

  return { track, droppedEvents: state.droppedEvents, deliveryError: state.deliveryError };
}
