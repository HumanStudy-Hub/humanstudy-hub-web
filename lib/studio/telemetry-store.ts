/**
 * Durable browser storage for undelivered research events (T08).
 *
 * IndexedDB is primary (quota is far larger than localStorage's ~5 MB); localStorage is the
 * fallback when IndexedDB is unavailable or refuses a write. Every event is its own record keyed by
 * id, so tabs never rewrite or take ownership of each other's records and an acknowledgement only
 * removes the ids it confirmed. Undelivered events are never pruned by count or age; only the
 * quarantine of server-rejected records is capped (MAX_REJECTED, newest kept). A write neither store accepts is
 * reported to the caller so the page can show it.
 */
import type { StudioEvent } from "./types";

export const STORAGE_PREFIX = "hs-studio-telemetry:";
const DB_NAME = "hs-studio-research";
const EVENTS = "events";
const REJECTED = "rejected";
/** Rejected records are kept for review, but bounded: only the newest are retained (all workspaces). */
export const MAX_REJECTED = 500;

type Row = { key: string; workspace: string; event: StudioEvent };
type RejectedRow = { key: string; workspace: string; event: StudioEvent; status: number; rejectedAt?: number };

const rejectedOrder = (row: { rejectedAt?: unknown; event?: { at?: unknown } } | null | undefined): number =>
  typeof row?.rejectedAt === "number" ? row.rejectedAt : Date.parse(String(row?.event?.at ?? "")) || 0;

export interface TelemetryStore {
  /** Synchronous: is any durable store present at all (not whether it has room)? */
  available(): boolean;
  /** Resolves with where the events became durable; rejects only when no store accepted them. */
  put(events: StudioEvent[]): Promise<"indexeddb" | "localstorage">;
  /** Synchronous best effort for unload paths (localStorage only). Returns whether all were written. */
  putSync(events: StudioEvent[]): boolean;
  /** Every stored, undelivered event for the workspace across both stores (read only). */
  all(): Promise<StudioEvent[]>;
  remove(ids: Iterable<string>): Promise<void>;
  reject(event: StudioEvent, status: number): Promise<void>;
}

function local(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
const eventKey = (workspace: string, id: string) => `${STORAGE_PREFIX}${workspace}:event:${id}`;

export function isStoredEvent(value: unknown): value is StudioEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<StudioEvent>;
  if (typeof event.id !== "string" || typeof event.sessionId !== "string" || typeof event.type !== "string" || typeof event.at !== "string") return false;
  return event.type !== ("pointer" as string) && Number.isFinite(Date.parse(event.at));
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error ?? new Error("indexeddb_request_failed")); });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexeddb_transaction_failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb_transaction_aborted"));
  });
}

let opening: Promise<IDBDatabase | null> | null = null;
function database(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase | null>((resolve) => {
    let factory: IDBFactory | undefined;
    try { factory = typeof indexedDB === "undefined" ? undefined : indexedDB; } catch { factory = undefined; }
    if (!factory) return resolve(null);
    let req: IDBOpenDBRequest;
    try { req = factory.open(DB_NAME, 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EVENTS)) db.createObjectStore(EVENTS, { keyPath: "key" });
      if (!db.objectStoreNames.contains(REJECTED)) db.createObjectStore(REJECTED, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  // A failed open (private mode, disabled storage) retries on the next page, not on every event.
  return opening;
}
/** Test hook: forget the cached database handle. */
export function resetTelemetryDatabase(): void { opening = null; }

export function createTelemetryStore(workspace: string): TelemetryStore {
  const prefix = `${STORAGE_PREFIX}${workspace}:`;
  const putLocal = (events: StudioEvent[]): boolean => {
    const store = local();
    if (!store) return false;
    try { for (const event of events) store.setItem(eventKey(workspace, event.id), JSON.stringify(event)); return true; }
    catch { return false; }
  };
  return {
    available() {
      try { if (typeof indexedDB !== "undefined" && indexedDB) return true; } catch { /* denied */ }
      const store = local();
      if (!store) return false;
      try { void store.length; return true; } catch { return false; }
    },
    async put(events) {
      const db = await database();
      if (db) {
        try {
          const tx = db.transaction(EVENTS, "readwrite"), store = tx.objectStore(EVENTS);
          for (const event of events) store.put({ key: `${workspace}:${event.id}`, workspace, event } satisfies Row);
          await done(tx);
          return "indexeddb";
        } catch { /* quota or a closed database: fall back */ }
      }
      if (putLocal(events)) return "localstorage";
      throw new Error("research_storage_unavailable");
    },
    putSync: putLocal,
    async all() {
      const seen = new Set<string>(), out: StudioEvent[] = [];
      const add = (event: unknown) => { if (isStoredEvent(event) && !seen.has(event.id)) { seen.add(event.id); out.push(event); } };
      const db = await database();
      if (db) {
        try {
          const rows = await request(db.transaction(EVENTS, "readonly").objectStore(EVENTS).getAll()) as Row[];
          for (const row of rows) if (row?.workspace === workspace) add(row.event);
        } catch { /* fall through to localStorage */ }
      }
      const store = local();
      if (store) {
        try {
          const keys: string[] = [];
          for (let i = 0; i < store.length; i++) { const key = store.key(i); if (key?.startsWith(prefix) && !key.includes(":rejected:")) keys.push(key); }
          for (const key of keys) {
            // Legacy (pre-v1) array records and per-event records; corrupt data is left for recovery.
            try { const parsed: unknown = JSON.parse(store.getItem(key) || "[]"); for (const event of Array.isArray(parsed) ? parsed : [parsed]) add(event); } catch { /* keep */ }
          }
        } catch { /* storage denied */ }
      }
      return out;
    },
    async remove(ids) {
      const list = [...ids];
      if (!list.length) return;
      // localStorage first and synchronously, so an acknowledged event never lingers there.
      const store = local();
      if (store) try {
        const set = new Set(list);
        for (const id of list) store.removeItem(eventKey(workspace, id));
        // Saved pre-v1 arrays: remove acknowledged ids only, never whole queues.
        const keys = Array.from({ length: store.length }, (_, i) => store.key(i)).filter((k): k is string => Boolean(k?.startsWith(prefix) && !k.includes(":event:") && !k.includes(":rejected:")));
        for (const key of keys) {
          const parsed: unknown = JSON.parse(store.getItem(key) || "[]");
          if (!Array.isArray(parsed)) continue;
          const left = parsed.filter((e: { id?: string }) => !set.has(e?.id ?? ""));
          if (left.length === parsed.length) continue;
          if (left.length) store.setItem(key, JSON.stringify(left)); else store.removeItem(key);
        }
      } catch { /* never loses unacknowledged data */ }
      const db = await database();
      if (db) {
        try { const tx = db.transaction(EVENTS, "readwrite"), objects = tx.objectStore(EVENTS); for (const id of list) objects.delete(`${workspace}:${id}`); await done(tx); }
        catch { /* a later duplicate send is harmless: ids are idempotent on the server */ }
      }
    },
    async reject(event, status) {
      const rejectedAt = Date.now();
      const db = await database();
      if (db) {
        try {
          const tx = db.transaction(REJECTED, "readwrite"), objects = tx.objectStore(REJECTED), finished = done(tx);
          objects.put({ key: `${workspace}:${event.id}`, workspace, event, status, rejectedAt } satisfies RejectedRow);
          // Pruned inside the same transaction, from the request callback (keeps it active).
          const all = objects.getAll();
          all.onsuccess = () => {
            const rows = all.result as RejectedRow[];
            if (rows.length <= MAX_REJECTED) return;
            for (const row of [...rows].sort((a, b) => rejectedOrder(a) - rejectedOrder(b)).slice(0, rows.length - MAX_REJECTED)) objects.delete(row.key);
          };
          await finished;
          return;
        } catch { /* fall back */ }
      }
      const store = local();
      if (!store) throw new Error("research_storage_unavailable");
      store.setItem(`${prefix}rejected:${event.id}`, JSON.stringify({ event, status, rejectedAt }));
      try {
        const keys: Array<[string, number]> = [];
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (!key?.startsWith(STORAGE_PREFIX) || !key.includes(":rejected:")) continue;
          let order = 0;
          try { order = rejectedOrder(JSON.parse(store.getItem(key) || "null")); } catch { /* corrupt: oldest */ }
          keys.push([key, order]);
        }
        if (keys.length > MAX_REJECTED) for (const [key] of keys.sort((a, b) => a[1] - b[1]).slice(0, keys.length - MAX_REJECTED)) store.removeItem(key);
      } catch { /* pruning is best effort */ }
    },
  };
}
