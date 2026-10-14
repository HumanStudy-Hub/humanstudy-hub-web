-- Beta policy (2026-10-13): users cannot delete their research data themselves. Deletion requests
-- go through the team (service role). Restore these three policies to re-enable self-service delete.
drop policy if exists desktop_events_delete on public.desktop_events;
drop policy if exists desktop_replay_chunks_delete on public.desktop_replay_chunks;
drop policy if exists desktop_replays_delete on storage.objects;
