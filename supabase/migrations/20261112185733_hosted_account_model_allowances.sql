-- Extend the existing smoke allowance; do not create grants or enable any environment.
alter table public.online_dev_model_budget drop constraint online_dev_model_budget_pkey;
alter table public.online_dev_model_budget alter column singleton drop not null;
alter table public.online_dev_model_budget alter column user_id drop not null;
alter table public.online_dev_model_budget add column budget_key text not null default 'smoke';
alter table public.online_dev_model_budget add column environment text not null default 'dev' check (environment in ('dev', 'production'));
alter table public.online_dev_model_budget add column scope text not null default 'smoke' check (scope in ('smoke', 'pool', 'account'));
alter table public.online_dev_model_budget add column revoked boolean not null default false;
grant update (revoked) on public.online_dev_model_budget to service_role;
alter table public.online_dev_model_budget add primary key (budget_key);
alter table public.online_dev_model_budget add constraint model_allowance_identity check (
  (scope='smoke' and singleton is true and budget_key='smoke' and user_id is not null and environment='dev') or
  (scope='pool' and singleton is null and user_id is null and budget_key=environment || ':pool') or
  (scope='account' and singleton is null and user_id is not null and budget_key=environment || ':account:' || user_id::text)
);
alter table public.online_dev_model_budget drop constraint if exists online_dev_model_budget_remaining_microusd_check;
alter table public.online_dev_model_budget add constraint model_allowance_amount check (remaining_microusd between 0 and 1000000000 and (scope<>'smoke' or remaining_microusd<=9000000));
alter table public.online_dev_model_budget drop constraint if exists online_dev_model_budget_remaining_requests_check;
alter table public.online_dev_model_budget add constraint model_allowance_requests check (remaining_requests between 0 and 1000000 and (scope<>'smoke' or remaining_requests<=100));
-- Existing smoke RPC only selects singleton=true. New rows use NULL, preserving that route.

create table public.online_model_reservations (
  id uuid primary key,
  environment text not null check (environment in ('dev','production')),
  account_id uuid not null,
  model_id text not null,
  reserved_microusd integer not null check (reserved_microusd > 0),
  actual_microusd bigint check (actual_microusd >= 0),
  state text not null default 'pending' check (state in ('pending','settled','overrun')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check ((state='pending' and actual_microusd is null and settled_at is null) or
         (state<>'pending' and actual_microusd is not null and settled_at is not null))
);
-- Retain pending charges even if an account/grant is removed. No source/chat content is stored here.
alter table public.online_model_reservations enable row level security;
revoke all on public.online_model_reservations from public, anon, authenticated, service_role;
grant select, insert, update on public.online_model_reservations to service_role;

create function public.online_reserve_account_model_budget(request_id uuid, budget_environment text, account_id uuid, model_id text, reservation_microusd integer)
returns boolean language plpgsql security invoker set search_path='' as $$
declare
  pool public.online_dev_model_budget%rowtype;
  account public.online_dev_model_budget%rowtype;
begin
  if budget_environment not in ('dev','production') or request_id is null or account_id is null or reservation_microusd is null or reservation_microusd <= 0 then return false; end if;
  -- Every reserve/settle locks pool then account, preventing cross-request lock inversion.
  select * into pool from public.online_dev_model_budget where budget_key=budget_environment || ':pool' for update;
  if not found then return false; end if;
  select * into account from public.online_dev_model_budget where budget_key=budget_environment || ':account:' || account_id::text for update;
  if not found then return false; end if;
  if exists(select 1 from public.online_model_reservations where id=request_id) then return false; end if;
  if pool.revoked or account.revoked or pool.expires_at <= clock_timestamp() or account.expires_at <= clock_timestamp()
    or pool.remaining_requests < 1 or account.remaining_requests < 1
    or pool.remaining_microusd < reservation_microusd or account.remaining_microusd < reservation_microusd
    or model_id is null or not(model_id=any(pool.models)) or not(model_id=any(account.models)) then return false; end if;
  update public.online_dev_model_budget set remaining_microusd=remaining_microusd-reservation_microusd,
    remaining_requests=remaining_requests-1 where budget_key in (pool.budget_key, account.budget_key);
  insert into public.online_model_reservations(id,environment,account_id,model_id,reserved_microusd)
    values(request_id,budget_environment,account_id,model_id,reservation_microusd);
  return true;
end;
$$;

-- Trusted server reconciliation only. Complete provider usage, never a client-provided cost.
create function public.online_settle_account_model_budget(request_id uuid, budget_environment text, actual_microusd bigint)
returns boolean language plpgsql security invoker set search_path='' as $$
declare
  reservation public.online_model_reservations%rowtype;
  pool_key text;
  account_key text;
  refund integer;
begin
  if actual_microusd is null or actual_microusd < 0 or budget_environment not in ('dev','production') then return false; end if;
  select * into reservation from public.online_model_reservations where id=request_id and environment=budget_environment;
  if not found then return false; end if;
  pool_key := budget_environment || ':pool';
  account_key := budget_environment || ':account:' || reservation.account_id::text;
  perform 1 from public.online_dev_model_budget where budget_key=pool_key for update;
  if not found then return false; end if;
  perform 1 from public.online_dev_model_budget where budget_key=account_key for update;
  if not found then return false; end if;
  select * into reservation from public.online_model_reservations where id=request_id for update;
  if reservation.state <> 'pending' then return reservation.state='settled' and reservation.actual_microusd=actual_microusd; end if;
  if actual_microusd > reservation.reserved_microusd then
    -- Unexpected provider cost cannot be erased: record it and stop this pool/account.
    update public.online_dev_model_budget set remaining_microusd=0, revoked=true where budget_key in (pool_key,account_key);
    update public.online_model_reservations set state='overrun', actual_microusd=online_settle_account_model_budget.actual_microusd,
      settled_at=clock_timestamp() where id=request_id;
    return false;
  end if;
  refund := reservation.reserved_microusd-actual_microusd;
  update public.online_dev_model_budget set remaining_microusd=remaining_microusd+refund where budget_key in (pool_key,account_key);
  update public.online_model_reservations set state='settled', actual_microusd=online_settle_account_model_budget.actual_microusd,
    settled_at=clock_timestamp() where id=request_id;
  return true;
end;
$$;
revoke execute on function public.online_reserve_account_model_budget(uuid,text,uuid,text,integer), public.online_settle_account_model_budget(uuid,text,bigint) from public, anon, authenticated;
grant execute on function public.online_reserve_account_model_budget(uuid,text,uuid,text,integer), public.online_settle_account_model_budget(uuid,text,bigint) to service_role;

-- Discover only the caller account's currently enabled models; no balances or other accounts.
create function public.online_account_model_access(budget_environment text, account_id uuid)
returns text[] language sql security invoker set search_path='' as $$
 select coalesce(array_agg(distinct model),array[]::text[])
 from public.online_dev_model_budget pool
 join public.online_dev_model_budget account on account.budget_key=budget_environment || ':account:' || account_id::text
 cross join lateral unnest(account.models) as model
 where pool.budget_key=budget_environment || ':pool' and budget_environment in ('dev','production')
   and not pool.revoked and not account.revoked
   and pool.expires_at>clock_timestamp() and account.expires_at>clock_timestamp()
   and pool.remaining_microusd>0 and account.remaining_microusd>0
   and pool.remaining_requests>0 and account.remaining_requests>0
   and model=any(pool.models);
$$;
revoke execute on function public.online_account_model_access(text,uuid) from public,anon,authenticated;
grant execute on function public.online_account_model_access(text,uuid) to service_role;
