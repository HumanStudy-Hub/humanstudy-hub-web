// Loads the real T08 research modules for route/pipeline harnesses. With the collection flag off
// (the default) server-capture is exactly the previous saveWorkspace call.
export function researchDeps(load, { store, http, after = (fn) => { void fn(); } } = {}) {
  const contract = load('lib/research-data/contract.ts');
  const producer = load('lib/research-data/server-producer.ts', { './contract': contract });
  const outbox = load('lib/research-data/server-outbox.ts', { './contract': contract });
  const capture = load('lib/research-data/server-capture.ts', { 'next/server': { after }, '../studio/http': http, '../studio/store': store, './server-producer': producer, './server-outbox': outbox });
  return {
    contract, producer, outbox, capture,
    deps: {
      '../research-data/server-capture': capture, '@/lib/research-data/server-capture': capture,
      '../research-data/server-producer': producer, '@/lib/research-data/server-producer': producer,
      '@/lib/research-data/server-outbox': outbox,
    },
  };
}
