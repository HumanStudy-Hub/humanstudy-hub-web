-- One explicitly provisioned dev model allowance. No row means no spending.
create table public.online_dev_model_budget (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null references auth.users(id) on delete cascade,
  models text[] not null check (cardinality(models) between 1 and 2 and array_position(models, null) is null),
  expires_at timestamptz not null,
  remaining_microusd integer not null check (remaining_microusd between 0 and 9000000),
  remaining_requests integer not null check (remaining_requests between 0 and 100)
);

alter table public.online_dev_model_budget enable row level security;
revoke all on public.online_dev_model_budget from public, anon, authenticated, service_role;
grant select on public.online_dev_model_budget to service_role;
grant update (remaining_microusd, remaining_requests) on public.online_dev_model_budget to service_role;

-- The same row is both the authorization and the lock. The debit is retained
-- even if the caller disconnects or the upstream outcome is uncertain.
create function public.online_reserve_dev_model_budget(account_id uuid, model_id text, reservation_microusd integer)
returns boolean language sql security invoker set search_path = '' as $$
  with debited as (
    update public.online_dev_model_budget
    set remaining_microusd = remaining_microusd - reservation_microusd,
        remaining_requests = remaining_requests - 1
    where singleton and user_id = account_id and model_id = any(models)
      and expires_at > pg_catalog.clock_timestamp() and remaining_requests > 0
      and reservation_microusd > 0 and remaining_microusd >= reservation_microusd
    returning 1
  )
  select exists (select 1 from debited);
$$;

revoke execute on function public.online_reserve_dev_model_budget(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.online_reserve_dev_model_budget(uuid, text, integer) to service_role;
