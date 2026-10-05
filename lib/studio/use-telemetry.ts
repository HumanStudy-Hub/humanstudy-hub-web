"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioEvent } from "./types";

type ExplicitEvent = Extract<StudioEvent["type"], "selection" | "chat" | "review">;
type Metadata = StudioEvent["metadata"];
type TelemetryState = { droppedEvents: number; deliveryError: string | null };

const MAX_QUEUE = 500;
const BATCH_SIZE = 50;
const POINTER_INTERVAL_MS = 250;
const FLUSH_INTERVAL_MS = 5000;
const MAX_RETRIES = 5;
const METADATA_KEYS = new Set(["action", "area", "mode", "status", "sourceId", "conversationId", "entityId", "reviewId", "page", "count", "selectionLength", "button", "direction"]);

function cleanMetadata(metadata?: Metadata): Metadata | undefined {
  if (!metadata) return undefined;
  const clean: NonNullable<Metadata> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 12)) {
    if (!METADATA_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
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

function normalized(value: number, start: number, size: number): number {
  if (!size) return 0;
  return Math.round(Math.max(0, Math.min(1, (value - start) / size)) * 1000) / 1000;
}

export function useStudioTelemetry({ workspaceId, enabled }: { workspaceId?: string; enabled: boolean }): {
  track: (type: ExplicitEvent, metadata?: Metadata) => void;
  droppedEvents: number;
  deliveryError: string | null;
} {
  const [state, setState] = useState<TelemetryState>({ droppedEvents: 0, deliveryError: null });
  const enqueueRef = useRef<((type: StudioEvent["type"], fields?: Partial<StudioEvent>) => void) | null>(null);
  const sessionIdRef = useRef("");

  const track = useCallback((type: ExplicitEvent, metadata?: Metadata) => {
    enqueueRef.current?.(type, { metadata: cleanMetadata(metadata) });
  }, []);

  useEffect(() => {
    if (!enabled || !workspaceId || typeof document === "undefined") return;
    const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-studio-workspace]"));
    const root = roots.find((element) => element.getAttribute("data-studio-workspace") === workspaceId)
      ?? roots.find((element) => !element.getAttribute("data-studio-workspace"));
    if (!root) return;

    if (!sessionIdRef.current) sessionIdRef.current = crypto.randomUUID();
    const endpoint = `/api/studio/workspaces/${encodeURIComponent(workspaceId)}/events`;
    const queue: StudioEvent[] = [];
    let stopped = false;
    let sending = false;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let visibleSince = document.visibilityState === "visible" ? Date.now() : 0;
    let lastPointerAt = 0;
    let requestController: AbortController | null = null;
    let inFlightBatch: StudioEvent[] = [];

    const drop = (count: number) => {
      if (count) setState((previous) => ({ ...previous, droppedEvents: previous.droppedEvents + count }));
    };
    const enqueue = (type: StudioEvent["type"], fields: Partial<StudioEvent> = {}) => {
      if (stopped) return;
      if (queue.length >= MAX_QUEUE) {
        queue.shift();
        drop(1);
      }
      queue.push({
        id: crypto.randomUUID(),
        sessionId: sessionIdRef.current,
        type,
        at: new Date().toISOString(),
        ...fields,
      });
      if (queue.length >= BATCH_SIZE) void flush();
    };

    const flush = async () => {
      if (stopped || sending || !queue.length || retryTimer) return;
      sending = true;
      const batch = queue.splice(0, BATCH_SIZE);
      inFlightBatch = batch;
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
          retryable = response.status === 429 || response.status >= 500;
          throw new Error(`HTTP ${response.status}`);
        }
        inFlightBatch = [];
        retryCount = 0;
        setState((previous) => previous.deliveryError ? { ...previous, deliveryError: null } : previous);
      } catch {
        if (!stopped) {
          retryCount++;
          if (!retryable || retryCount > MAX_RETRIES) {
            drop(batch.length);
            retryCount = 0;
            setState((previous) => ({ ...previous, deliveryError: "Telemetry delivery failed; some events were dropped." }));
          } else {
            queue.unshift(...batch);
            if (queue.length > MAX_QUEUE) drop(queue.splice(MAX_QUEUE).length);
            setState((previous) => ({ ...previous, deliveryError: "Telemetry delivery is retrying." }));
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              void flush();
            }, Math.min(30000, 1000 * 2 ** (retryCount - 1)));
          }
        }
      } finally {
        inFlightBatch = [];
        clearTimeout(timeout);
        requestController = null;
        sending = false;
        if (!stopped && queue.length && !retryTimer && retryCount === 0) void flush();
      }
    };

    enqueueRef.current = enqueue;
    const onClick = (event: MouseEvent) => {
      const target = semanticTarget(event.target, root);
      if (target) enqueue("click", { target });
    };
    const onPointer = (event: PointerEvent) => {
      if (document.visibilityState !== "visible" || Date.now() - lastPointerAt < POINTER_INTERVAL_MS) return;
      lastPointerAt = Date.now();
      const rect = root.getBoundingClientRect();
      enqueue("pointer", {
        x: normalized(event.clientX, rect.left, rect.width),
        y: normalized(event.clientY, rect.top, rect.height),
      });
    };
    const onScroll = (event: Event) => {
      const element = event.target;
      if (!(element instanceof Element) || !root.contains(element)) return;
      const maxY = element.scrollHeight - element.clientHeight;
      if (maxY <= 0) return;
      enqueue("scroll", {
        target: semanticTarget(element, root),
        y: normalized(element.scrollTop, 0, maxY),
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        enqueue("visibility", { durationMs: visibleSince ? Math.min(86_400_000, Date.now() - visibleSince) : 0, metadata: { status: "hidden" } });
        visibleSince = 0;
        void flush();
      } else {
        visibleSince = Date.now();
        enqueue("visibility", { metadata: { status: "visible" } });
      }
    };
    const sendFinal = () => {
      const pending = [...inFlightBatch, ...queue.splice(0)];
      inFlightBatch = [];
      let bytes = 0;
      for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
        const body = JSON.stringify({ events: pending.slice(offset, offset + BATCH_SIZE) });
        // Browsers normally cap all outstanding keepalive bodies at about 64 KiB.
        if (bytes + body.length > 60_000) {
          if (!stopped) drop(pending.length - offset);
          break;
        }
        bytes += body.length;
        try {
          void fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
        } catch {
          if (!stopped) drop(pending.length - offset);
          break;
        }
      }
    };
    const onPageHide = () => {
      if (visibleSince) {
        enqueue("visibility", { durationMs: Math.min(86_400_000, Date.now() - visibleSince), metadata: { status: "hidden" } });
        visibleSince = 0;
      }
      sendFinal();
    };

    root.addEventListener("click", onClick);
    root.addEventListener("pointermove", onPointer);
    root.addEventListener("scroll", onScroll, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    const interval = setInterval(() => { if (document.visibilityState === "visible") void flush(); }, FLUSH_INTERVAL_MS);
    if (visibleSince) enqueue("visibility", { metadata: { status: "visible" } });

    return () => {
      if (visibleSince) enqueue("visibility", { durationMs: Math.min(86_400_000, Date.now() - visibleSince), metadata: { status: "hidden" } });
      stopped = true;
      enqueueRef.current = null;
      root.removeEventListener("click", onClick);
      root.removeEventListener("pointermove", onPointer);
      root.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      clearInterval(interval);
      if (retryTimer) clearTimeout(retryTimer);
      requestController?.abort();
      // A final bounded keepalive request can outlive this component.
      sendFinal();
    };
  }, [enabled, workspaceId]);

  return { track, droppedEvents: state.droppedEvents, deliveryError: state.deliveryError };
}
