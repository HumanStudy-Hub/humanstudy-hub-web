-- Legacy desktop_events: accept consented events captured offline more than 30 days ago.
-- Separate from the contract migration so the owner can apply or drop it independently.
-- (First drafted 2026-10-13 as 20261013071140_desktop_events_allow_offline_capture, never applied.)
--
-- Desktop <= 0.6.6 keeps such events in its local queue and retries them; with the 30-day lower
-- bound they can never be delivered and the dataset silently loses them. Ownership and the future
-- timestamp guard stay exactly as before. Only the lower bound is removed; nothing is narrowed.
alter policy desktop_events_insert on public.desktop_events
  to authenticated
  with check (
    owner_id = (select auth.uid())
    and occurred_at <= now() + interval '5 minutes'
  );
