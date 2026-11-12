-- This table coordinates compute admission across Vercel function instances.
-- Only the Hub server can reserve a workspace, and the provider's own limit still applies.
create table public.online_workspace_capacity (
  scope text primary key check (scope in ('production', 'preview')),
  max_running integer not null check (max_running > 0)
);
insert into public.online_workspace_capacity (scope, max_running) values ('production', 6), ('preview', 6);

create table public.online_workspace_leases (
  workspace text primary key,
  scope text not null references public.online_workspace_capacity(scope),
  reserved_until timestamptz not null,
  operation uuid not null,
  attempt uuid,
  operation_until timestamptz not null,
  stopping boolean not null,
  cancelled boolean not null default false
);
create table public.online_workspace_cancellations (
  workspace text not null,
  attempt uuid not null,
  expires_at timestamptz not null,
  primary key (workspace, attempt)
);
alter table public.online_workspace_cancellations enable row level security;
revoke all on public.online_workspace_cancellations from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.online_workspace_cancellations to service_role;

alter table public.online_workspace_capacity enable row level security;
alter table public.online_workspace_leases enable row level security;
revoke all on public.online_workspace_capacity, public.online_workspace_leases from public, anon, authenticated, service_role;
grant select on public.online_workspace_capacity to service_role;
grant select, insert, update, delete on public.online_workspace_leases to service_role;

create function public.online_claim_workspace(workspace_name text, session_seconds integer, request_stop boolean, attempt_id uuid)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  current_lease public.online_workspace_leases%rowtype;
  requested_at timestamptz;
  claim uuid := gen_random_uuid();
  capacity integer;
  capacity_scope text;
begin
  if workspace_name is null or workspace_name !~ '^try-(preview-[a-f0-9]{12}-)?[a-f0-9-]{36}$'
    or session_seconds is null or session_seconds < 60 or session_seconds > 86400 or request_stop is null or (not request_stop and attempt_id is null) then
    raise exception 'invalid workspace admission parameters';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('humanstudy.online-workspace-admission', 0));
  requested_at := pg_catalog.clock_timestamp();
  capacity_scope := case when workspace_name like 'try-preview-%' then 'preview' else 'production' end;
  delete from public.online_workspace_leases
    where reserved_until <= requested_at and operation_until <= requested_at;

  delete from public.online_workspace_cancellations where expires_at <= requested_at;
  if request_stop and attempt_id is not null then
    insert into public.online_workspace_cancellations values (workspace_name, attempt_id, requested_at + interval '180 seconds')
    on conflict (workspace, attempt) do update set expires_at = excluded.expires_at;
  elsif not request_stop and exists (
    select 1 from public.online_workspace_cancellations where workspace = workspace_name and attempt = attempt_id
  ) then
    return 'cancelled';
  end if;

  select * into current_lease from public.online_workspace_leases where workspace = workspace_name;
  if request_stop and attempt_id is not null and current_lease.attempt is distinct from attempt_id then
    -- Keep the tombstone for out-of-order requests without stopping a newer session.
    return 'ignored';
  end if;
  if current_lease.operation_until > requested_at then
    if request_stop and not current_lease.stopping then
      update public.online_workspace_leases set cancelled = true where workspace = workspace_name;
      return 'cancelling';
    end if;
    return null;
  end if;

  if not request_stop and (current_lease.reserved_until is null or current_lease.reserved_until <= requested_at) then
    select max_running into strict capacity from public.online_workspace_capacity where scope = capacity_scope;
    if (select count(*) from public.online_workspace_leases where scope = capacity_scope and reserved_until > requested_at) >= capacity then
      return null;
    end if;
  end if;

  insert into public.online_workspace_leases (workspace, scope, reserved_until, operation, attempt, operation_until, stopping)
    values (
      workspace_name, capacity_scope,
      case when request_stop then coalesce(current_lease.reserved_until, requested_at)
        else greatest(current_lease.reserved_until, requested_at + pg_catalog.make_interval(secs => session_seconds + 180)) end,
      claim, attempt_id, requested_at + interval '180 seconds', request_stop
    )
  on conflict (workspace) do update set
    reserved_until = excluded.reserved_until, operation = excluded.operation,
    attempt = excluded.attempt, operation_until = excluded.operation_until, stopping = excluded.stopping, cancelled = false;
  return claim::text;
end
$$;

-- A successful startup may supply the actual provider expiry. Null keeps the conservative reservation.
-- A rejected completion means the launcher must not return a browser URL.
create function public.online_finish_workspace(workspace_name text, claim_id uuid, release_slot boolean, provider_expiry timestamptz)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  affected integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('humanstudy.online-workspace-admission', 0));
  if release_slot then
    delete from public.online_workspace_leases where workspace = workspace_name and operation = claim_id;
  else
    update public.online_workspace_leases set
      operation_until = pg_catalog.clock_timestamp(),
      reserved_until = coalesce(provider_expiry, reserved_until)
    where workspace = workspace_name and operation = claim_id and not cancelled;
  end if;
  get diagnostics affected = row_count;
  return affected = 1;
end
$$;

revoke execute on function public.online_claim_workspace(text, integer, boolean, uuid),
  public.online_finish_workspace(text, uuid, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.online_claim_workspace(text, integer, boolean, uuid),
  public.online_finish_workspace(text, uuid, boolean, timestamptz) to service_role;
