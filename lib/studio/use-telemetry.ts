"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioEvent } from "./types";
import { createTelemetryStore } from "./telemetry-store";
import { createWebOperations, shortcutName, type ActionOptions, type WebOperations } from "../research-data/web-operations";

// Collection contract (HumanStudy-Hub/humanstudy-desktop#27, causality T10): one primary event per
// user operation (lib/research-data/web-operations.ts), scrolling summarized when it settles, and no
// pointer trajectories, keystrokes or continuous recordings.

type ExplicitEvent = Extract<StudioEvent["type"], "selection" | "layout">;
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
export { STORAGE_PREFIX } from "./telemetry-store";
const METADATA_KEYS = new Set(["action", "area", "mode", "status", "sourceId", "conversationId", "entityId", "reviewId", "page", "count", "selectionLength", "button", "direction", "startDepth", "endDepth", "maxDepth", "via", "parentActionId"]);

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

export function useStudioTelemetry({ workspaceId, enabled, surfaceVersion, workspaceRevision }: { workspaceId?: string; enabled: boolean; surfaceVersion?: number | string; workspaceRevision?: number }): {
  /** A completion record (selection, layout), linked to the operation in progress. */
  track: (type: ExplicitEvent, metadata?: Metadata) => void;
  /**
   * A semantic product action. Names the operation in progress (or starts a system one) and returns
   * its id, so server producers link to it (action_id) instead of recording a second primary.
   */
  action: (name: string, options?: ActionOptions) => string | undefined;
  droppedEvents: number;
  deliveryError: string | null;
} {
  const [state, setState] = useState<TelemetryState>({ droppedEvents: 0, deliveryError: null });
  const opsRef = useRef<WebOperations | null>(null);
  const sessionIdRef = useRef("");
  const installIdRef = useRef("");
  const seqRef = useRef(0);
  const revisionRef = useRef(workspaceRevision);
  useEffect(() => { revisionRef.current = workspaceRevision; }, [workspaceRevision]);

  const track = useCallback((type: ExplicitEvent, metadata?: Metadata) => {
    opsRef.current?.record(type, cleanMetadata(metadata));
  }, []);
  const action = useCallback((name: string, options: ActionOptions = {}) => {
    return opsRef.current?.action(name, { ...options, metadata: cleanMetadata(options.metadata) });
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
    // IndexedDB first, localStorage fallback; one record per event id, never pruned.
    const durable = createTelemetryStore(workspaceId);
    // Every undelivered event, including those in flight; removed by id only on success.
    const queue: StudioEvent[] = [];
    const stored = new Set<string>(), acknowledged = new Set<string>();
    const storageError = 'Local research storage is full or unavailable. Keep this page open until delivery succeeds.';
    let stopped = false;
    let sending = false;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    let visibleSince = document.visibilityState === "visible" ? Date.now() : 0;
    let requestController: AbortController | null = null;
    const scrollRuns = new Map<Element, ScrollRun>();

    /** Synchronously writes whatever is not yet durable (unload paths). Returns whether all of it is. */
    const persistNow = (): boolean => {
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = undefined; }
      const missing = queue.filter((event) => !stored.has(event.id));
      if (!missing.length) return true;
      // Tabs never rewrite or take ownership of another tab's records; each id is its own record.
      if (!durable.putSync(missing)) return false;
      for (const event of missing) stored.add(event.id);
      return true;
    };
    const remove = (sent: StudioEvent[]) => {
      const ids = new Set(sent.map((event) => event.id));
      for (let i = queue.length - 1; i >= 0; i--) if (ids.has(queue[i].id)) queue.splice(i, 1);
      for (const id of ids) { stored.delete(id); acknowledged.add(id); }
      void durable.remove(ids);
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
      if (!durable.available()) setState(previous => ({ ...previous, deliveryError: storageError }));
      else durable.put([event]).then(() => {
        // Delivered before the write finished: remove the late record instead of resending it.
        if (acknowledged.has(event.id)) void durable.remove([event.id]); else stored.add(event.id);
      }, () => setState(previous => ({ ...previous, deliveryError: storageError })));
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
                await durable.reject(event, single.status);
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

    const ops = createWebOperations({
      emit: (type, fields) => push(makeEvent(type, fields)),
      uuid: () => crypto.randomUUID(), now: () => Date.now(),
      later: (fn, ms) => setTimeout(fn, ms), cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      microtask: (fn) => queueMicrotask(fn),
    });
    opsRef.current = ops;

    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !root.contains(event.target)) return;
      // Opening the system file picker is not an operation by itself; choosing files is.
      const element = event.target.closest("[data-event],button,a,input,select,textarea,[role],label") ?? event.target;
      if (element instanceof HTMLInputElement && element.type === "file") return;
      if (element instanceof HTMLLabelElement && element.control instanceof HTMLInputElement && element.control.type === "file") return;
      const target = semanticTarget(event.target, root);
      if (!target) return;
      const via = event.target.closest('[data-research-via="menu"]') ? "menu" : event.detail === 0 ? "keyboard" : "pointer";
      ops.input(target, via, { join: event.isTrusted === false });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.target instanceof Element)) return;
      const menu = event.target.closest('[data-research-via="menu"]');
      if (menu && event.key === "Enter") {
        const active = menu.querySelector('[aria-selected="true"][data-event]')?.getAttribute("data-event");
        ops.input(active || "menu.command", "menu");
        return;
      }
      // Only the shortcut's name is kept, and only when no product action claims it.
      const name = shortcutName(event);
      if (name) { ops.input(`shortcut:${name}`, "shortcut"); return; }
      // Composer Enter: an operation only if a product action (the send) claims it; never a record.
      if (event.key === "Enter" && !event.shiftKey && event.target instanceof HTMLTextAreaElement && root.contains(event.target))
        ops.input("composer.enter", "keyboard", { fallback: false });
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
        ops.settleAll();
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
      ops.settleAll();
      endAllScrolls("unload");
      if (visibleSince) {
        enqueue("visibility", { durationMs: Math.min(86_400_000, Date.now() - visibleSince), metadata: { status: "hidden" } });
        visibleSince = 0;
      }
      persistAndSend();
    };

    root.addEventListener("click", onClick, { capture: true });
    window.addEventListener("keydown", onKeyDown, { capture: true });
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    const interval = setInterval(() => { if (document.visibilityState === "visible") void flush(); }, FLUSH_INTERVAL_MS);
    if (visibleSince) enqueue("visibility", { metadata: { status: "visible" } });
    // Take over events earlier pages, remounts or other tabs left undelivered. Read only: records
    // are deleted by id after acknowledgement, so a concurrent tab loses nothing.
    void durable.all().then((events) => {
      if (stopped) return;
      const known = new Set(queue.map((event) => event.id));
      let adopted = 0;
      for (const event of events) if (!known.has(event.id) && !acknowledged.has(event.id)) { queue.push(event); stored.add(event.id); adopted++; }
      if (adopted) void flush();
    }, () => undefined);

    return () => {
      ops.settleAll();
      endAllScrolls("view");
      if (visibleSince) enqueue("visibility", { durationMs: Math.min(86_400_000, Date.now() - visibleSince), metadata: { status: "hidden" } });
      const durable = persistNow();
      const pending = [...queue];
      stopped = true;
      opsRef.current = null;
      root.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener("keydown", onKeyDown, { capture: true });
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
        sendFinal(pending, (batch) => {
          remove(batch);
        });
      }, 0);
    };
  }, [enabled, workspaceId, surfaceVersion]);

  return { track, action, droppedEvents: state.droppedEvents, deliveryError: state.deliveryError };
}
