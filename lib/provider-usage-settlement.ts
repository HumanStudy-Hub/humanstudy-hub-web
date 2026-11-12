/** Observe only authenticated OpenRouter response bytes. Never parse client messages as accounting.
 * Bounded observer: exceeding its limit disables settlement, never truncates the forwarded response. */
const EVENT_LIMIT = 64 * 1024;
const JSON_LIMIT = 1024 * 1024;
const terminalReasons = new Set(['stop', 'tool_calls', 'length', 'content_filter']);
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
export type AccountingOutcome = { state: 'settled' | 'retained'; reason: string; generationId?: string; actualMicrousd?: number };

class UsageObserver {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private line = ''; private data = ''; private previousCR = false;
  private json = ''; private jsonBytes = 0;
  private failed = ''; private terminal = ''; private cost: number | null = null;
  private usageSignature = ''; private id = '';
  sawDone = false;
  get canLookAhead() { return this.sawDone && !this.failed; }
  constructor(private streaming: boolean, private headerId?: string) {}
  invalidate(reason: string) { this.failed ||= reason; this.line = ''; this.data = ''; this.json = ''; }
  private frame(value: unknown) {
    if (!record(value) || value.error != null || value.type === 'error') return this.invalidate('provider_error_or_invalid_frame');
    if (typeof value.id !== 'string' || !value.id || value.id.length > 256) return this.invalidate('missing_generation_identity');
    if ((this.id && value.id !== this.id) || (this.headerId && value.id !== this.headerId)) return this.invalidate('generation_identity_mismatch');
    this.id = value.id;
    if (!Array.isArray(value.choices)) return this.invalidate('missing_choices');
    for (const choice of value.choices) {
      if (!record(choice) || choice.index !== 0 || choice.error != null) return this.invalidate('invalid_choice');
      if (this.cost !== null) {
        const delta = choice.delta;
        if (value.usage == null || (delta != null && (!record(delta) || Object.entries(delta).some(([key, v]) =>
          !(key === 'role' && v === 'assistant') && !(key === 'content' && (v === '' || v === null))))))
          return this.invalidate('content_after_final_usage');
      }
      const reason = choice.finish_reason;
      if (reason != null) {
        if (typeof reason !== 'string' || !terminalReasons.has(reason) || (this.terminal && reason !== this.terminal)) return this.invalidate('invalid_finish_reason');
        this.terminal = reason;
      }
    }
    if (value.usage != null) {
      const usage = value.usage;
      if (!record(usage) || !this.terminal || typeof usage.cost !== 'number' || !Number.isFinite(usage.cost) || usage.cost < 0)
        return this.invalidate('missing_or_invalid_final_cost');
      const tokens = [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens];
      if (!tokens.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return this.invalidate('incomplete_usage');
      const amount = Math.ceil(usage.cost * 1_000_000);
      if (!Number.isSafeInteger(amount)) return this.invalidate('invalid_cost_range');
      const signature = JSON.stringify([usage.cost, ...tokens]);
      if (this.usageSignature && signature !== this.usageSignature) return this.invalidate('conflicting_usage');
      this.usageSignature = signature; this.cost = amount;
    }
  }
  private dispatch() {
    if (!this.data) return;
    const data = this.data.slice(0, -1); this.data = '';
    if (this.sawDone) return this.invalidate('data_after_done');
    if (data === '[DONE]') { this.sawDone = true; return; }
    try { this.frame(JSON.parse(data)); } catch { this.invalidate('invalid_accounting_json'); }
  }
  private endLine() {
    const line = this.line; this.line = '';
    if (!line) { this.dispatch(); return; }
    if (line.startsWith(':')) return;
    if (line.startsWith('event:') && line.slice(6).trim() === 'error') return this.invalidate('provider_error_event');
    if (line === 'data' || line.startsWith('data:')) {
      const value = line === 'data' ? '' : line.slice(5).replace(/^ /, '');
      if (this.data.length + value.length + 1 > EVENT_LIMIT) return this.invalidate('accounting_event_too_large');
      this.data += value + '\n';
    }
  }
  observe(bytes: Uint8Array) {
    if (this.failed) return;
    if (!this.streaming) {
      this.jsonBytes += bytes.byteLength;
      if (this.jsonBytes > JSON_LIMIT) return this.invalidate('accounting_json_too_large');
    }
    try {
      // Decode bounded slices even when a provider hands fetch one very large chunk.
      for (let at = 0; at < bytes.length && !this.failed; at += 8192) {
        const text = this.decoder.decode(bytes.subarray(at, at + 8192), { stream: true });
        if (!this.streaming) { this.json += text; continue; }
        for (const ch of text) {
          if (ch === '\r') { this.endLine(); this.previousCR = true; }
          else if (ch === '\n') { if (!this.previousCR) this.endLine(); this.previousCR = false; }
          else {
            this.previousCR = false;
            if (this.line.length >= EVENT_LIMIT) this.invalidate('accounting_line_too_large');
            else this.line += ch;
          }
          if (this.failed) break;
        }
      }
    } catch { this.invalidate('invalid_accounting_utf8'); }
  }
  complete(): AccountingOutcome {
    if (!this.failed) {
      try {
        const tail = this.decoder.decode();
        if (this.streaming) {
          if (tail || this.line || this.data) this.invalidate('incomplete_sse_frame');
          else if (!this.sawDone) this.invalidate('missing_done');
        } else { this.json += tail; this.frame(JSON.parse(this.json)); }
      } catch { this.invalidate('invalid_accounting_json'); }
    }
    if (!this.failed && (!this.terminal || this.cost === null)) this.invalidate('missing_final_usage');
    return { state: 'retained', reason: this.failed || 'verified_complete_usage', generationId: this.id || undefined,
      ...(!this.failed && this.cost !== null ? { actualMicrousd: this.cost } : {}) };
  }
}

/** Pull-driven, single-reader passthrough; no tee or whole-output buffering. */
export function withProviderUsageSettlement(upstream: Response, options: {
  streaming: boolean; signal: AbortSignal;
  settle: (actualMicrousd: number) => Promise<boolean>;
  report: (outcome: AccountingOutcome) => void;
}): ReadableStream<Uint8Array> | null {
  if (!upstream.body) {
    try { options.report({ state: 'retained', reason: 'missing_response_body' }); } catch { /* no response bytes to alter */ }
    return null;
  }
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  const supported = upstream.ok && !upstream.redirected && (options.streaming ? contentType.includes('text/event-stream') : contentType.includes('application/json'));
  const observer = new UsageObserver(options.streaming, upstream.headers.get('x-generation-id') || undefined);
  if (!supported) observer.invalidate('unsuccessful_or_unsupported_response');
  const reader = upstream.body.getReader();
  let cancelled = false, finalized = false;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let pendingError: Error | undefined;
  const abort = () => { cancelled = true; observer.invalidate('cancelled'); void reader.cancel().catch(() => undefined); };
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const finish = async () => {
    if (finalized) return;
    finalized = true;
    options.signal.removeEventListener('abort', abort);
    if (cancelled || options.signal.aborted) observer.invalidate('cancelled');
    let outcome = observer.complete();
    if (outcome.actualMicrousd !== undefined) {
      try {
        const settled = await options.settle(outcome.actualMicrousd);
        outcome = { ...outcome, state: settled ? 'settled' : 'retained', reason: settled ? 'verified_complete_usage' : 'settlement_unconfirmed_or_overrun' };
      } catch { outcome = { ...outcome, state: 'retained', reason: 'settlement_failed' }; }
    }
    try { options.report(outcome); } catch { /* accounting diagnostics must not alter output */ }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (pendingError) throw pendingError;
        const result = await (pendingRead ?? reader.read());
        pendingRead = undefined;
        if (result.done) { await finish(); controller.close(); return; }
        observer.observe(result.value);
        // Most SDKs cancel after [DONE]. Verify actual upstream EOF before releasing that
        // terminal chunk, so normal SDK completion is not mistaken for an interrupted request.
        if (options.streaming && observer.canLookAhead && !cancelled) {
          pendingRead = reader.read();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let next: ReadableStreamReadResult<Uint8Array> | null;
          try { next = await Promise.race([pendingRead, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); })]); }
          catch (error) {
            observer.invalidate('upstream_read_error'); pendingRead = undefined;
            pendingError = error instanceof Error ? error : new Error('Upstream read failed');
            controller.enqueue(result.value); // preserve bytes read before the following read failed
            return;
          } finally { if (timer) clearTimeout(timer); }
          if (next === null) observer.invalidate('terminal_eof_timeout');
          else if (next.done) { pendingRead = undefined; await finish(); controller.enqueue(result.value); controller.close(); return; }
          // Keep the single pending/resolved read for the next pull. No tee or accumulated tail.
        }
        controller.enqueue(result.value);
      } catch (error) {
        observer.invalidate('upstream_read_error');
        await finish(); controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true; observer.invalidate('cancelled');
      await reader.cancel(reason).catch(() => undefined);
      await finish();
    },
  });
}
