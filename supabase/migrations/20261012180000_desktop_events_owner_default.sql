-- The desktop app never sends owner_id; it is the signed-in user. Without a default every insert
-- failed the RLS check (owner_id = auth.uid()) and no usage events were stored.
alter table public.desktop_events alter column owner_id set default auth.uid();
alter table public.desktop_replay_chunks alter column owner_id set default auth.uid();
