-- Private help queue; support messages are separate from research telemetry.
create table if not exists public.support_requests (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  kind text not null check (kind in ('help', 'problem', 'suggestion')),
  message text not null check (char_length(btrim(message)) > 0 and char_length(message) <= 12000),
  reply_email text check (reply_email is null or (char_length(reply_email) <= 254 and reply_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  diagnostics jsonb not null default '{}'::jsonb check (
    jsonb_typeof(diagnostics) = 'object'
    and diagnostics - 'version' - 'platform' - 'arch' = '{}'::jsonb
    and octet_length(diagnostics::text) <= 512
  ),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  created_at timestamptz not null default now()
);
alter table public.support_requests enable row level security;
revoke all on public.support_requests from public, anon, authenticated;
grant select on public.support_requests to authenticated;
grant insert (id, owner_id, kind, message, reply_email, diagnostics) on public.support_requests to authenticated;
grant all on public.support_requests to service_role;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='support_requests' and policyname='support_insert_own') then
    create policy support_insert_own on public.support_requests for insert to authenticated
      with check ((select auth.uid()) = owner_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='support_requests' and policyname='support_read_own') then
    create policy support_read_own on public.support_requests for select to authenticated
      using ((select auth.uid()) = owner_id);
  end if;
end $$;
create index if not exists support_requests_owner_created on public.support_requests (owner_id, created_at desc);
create index if not exists support_requests_queue on public.support_requests (status, created_at);
comment on table public.support_requests is 'Explicit user-submitted help, problems and suggestions; team access through Supabase dashboard. No automatic attachments or transcript capture.';
notify pgrst, 'reload schema';
