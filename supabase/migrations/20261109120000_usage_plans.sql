-- Usage plans: each account's plan (free unless an admin sets pro) and its hosted-model spend per
-- calendar month (UTC). Additive only. Written by the server with the service role; users may read
-- their own rows and nothing else. Limits themselves live in lib/plans-config.ts, not here.
--
-- Set an account to Pro (admin, SQL editor or service role):
--   insert into public.account_plans (user_id, plan, note) values ('<user uuid>', 'pro', '<why>')
--   on conflict (user_id) do update set plan = excluded.plan, note = excluded.note, updated_at = now();
-- Back to Free: update public.account_plans set plan = 'free', updated_at = now() where user_id = '<user uuid>';

create table if not exists public.account_plans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  note text check (note is null or char_length(note) <= 500),
  updated_at timestamptz not null default now()
);
alter table public.account_plans enable row level security;
revoke all on public.account_plans from public, anon, authenticated;
grant select on public.account_plans to authenticated;
grant all on public.account_plans to service_role;

create table if not exists public.model_usage_monthly (
  user_id uuid not null references auth.users(id) on delete cascade,
  period date not null check (extract(day from period) = 1),
  cost_usd numeric(14, 6) not null default 0 check (cost_usd >= 0),
  requests integer not null default 0 check (requests >= 0),
  prompt_tokens bigint not null default 0 check (prompt_tokens >= 0),
  completion_tokens bigint not null default 0 check (completion_tokens >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, period)
);
alter table public.model_usage_monthly enable row level security;
revoke all on public.model_usage_monthly from public, anon, authenticated;
grant select on public.model_usage_monthly to authenticated;
grant all on public.model_usage_monthly to service_role;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'account_plans' and policyname = 'account_plans_read_own') then
    create policy account_plans_read_own on public.account_plans for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'model_usage_monthly' and policyname = 'model_usage_read_own') then
    create policy model_usage_read_own on public.model_usage_monthly for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

-- Calls in flight: each holds a reservation against the month until its cost is known. Rows older
-- than the stale window (a crashed function) stop counting and are removed on the next call.
create table if not exists public.model_calls_inflight (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period date not null check (extract(day from period) = 1),
  reserved_usd numeric(14, 6) not null check (reserved_usd >= 0),
  started_at timestamptz not null default now()
);
create index if not exists model_calls_inflight_user on public.model_calls_inflight (user_id, started_at);
alter table public.model_calls_inflight enable row level security;
revoke all on public.model_calls_inflight from public, anon, authenticated;
grant all on public.model_calls_inflight to service_role;

-- One call's cost added atomically to its month; returns the month's new total.
create or replace function public.add_model_usage(p_user uuid, p_period date, p_cost numeric, p_prompt bigint, p_completion bigint)
returns numeric
language sql
security invoker
set search_path = ''
as $$
  insert into public.model_usage_monthly as m (user_id, period, cost_usd, requests, prompt_tokens, completion_tokens)
  values (p_user, p_period, greatest(coalesce(p_cost, 0), 0), 1, greatest(coalesce(p_prompt, 0), 0), greatest(coalesce(p_completion, 0), 0))
  on conflict (user_id, period) do update set
    cost_usd = m.cost_usd + excluded.cost_usd,
    requests = m.requests + 1,
    prompt_tokens = m.prompt_tokens + excluded.prompt_tokens,
    completion_tokens = m.completion_tokens + excluded.completion_tokens,
    updated_at = now()
  returning cost_usd;
$$;

-- The account's plan and the month's spend in one round trip (checked before every hosted call).
create or replace function public.model_allowance(p_user uuid, p_period date)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'plan', coalesce((select plan from public.account_plans where user_id = p_user), 'free'),
    'used_usd', coalesce((select cost_usd from public.model_usage_monthly where user_id = p_user and period = p_period), 0)
  );
$$;

-- Admits one call: serialised per account, it refuses when too many calls are in flight ('busy') or
-- when spend plus every live reservation plus this one would pass the limit ('exhausted'); otherwise
-- it records the reservation and returns its id. The limits come from lib/plans-config.ts.
create or replace function public.begin_model_call(p_user uuid, p_period date, p_limit numeric, p_reserve numeric, p_max_inflight integer, p_stale_seconds integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_used numeric;
  v_reserved numeric;
  v_inflight integer;
  v_call uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('model_call:' || p_user::text, 0));
  delete from public.model_calls_inflight where user_id = p_user and started_at < now() - make_interval(secs => p_stale_seconds);
  select coalesce(sum(reserved_usd), 0), count(*) into v_reserved, v_inflight from public.model_calls_inflight where user_id = p_user;
  v_used := coalesce((select cost_usd from public.model_usage_monthly where user_id = p_user and period = p_period), 0);
  if v_inflight >= p_max_inflight then
    return jsonb_build_object('ok', false, 'reason', 'busy', 'used_usd', v_used);
  end if;
  if v_used + v_reserved + greatest(p_reserve, 0) > p_limit then
    return jsonb_build_object('ok', false, 'reason', 'exhausted', 'used_usd', v_used);
  end if;
  insert into public.model_calls_inflight (user_id, period, reserved_usd) values (p_user, p_period, greatest(p_reserve, 0)) returning id into v_call;
  return jsonb_build_object('ok', true, 'call', v_call, 'used_usd', v_used);
end;
$$;

-- Ends a call: drops its reservation and charges its cost to the month it was admitted in.
create or replace function public.end_model_call(p_call uuid, p_user uuid, p_period date, p_cost numeric, p_prompt bigint, p_completion bigint)
returns numeric
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.model_calls_inflight where id = p_call and user_id = p_user;
  return public.add_model_usage(p_user, p_period, p_cost, p_prompt, p_completion);
end;
$$;

revoke all on function public.begin_model_call(uuid, date, numeric, numeric, integer, integer) from public, anon, authenticated;
revoke all on function public.end_model_call(uuid, uuid, date, numeric, bigint, bigint) from public, anon, authenticated;
grant execute on function public.begin_model_call(uuid, date, numeric, numeric, integer, integer) to service_role;
grant execute on function public.end_model_call(uuid, uuid, date, numeric, bigint, bigint) to service_role;

revoke all on function public.add_model_usage(uuid, date, numeric, bigint, bigint) from public, anon, authenticated;
revoke all on function public.model_allowance(uuid, date) from public, anon, authenticated;
grant execute on function public.add_model_usage(uuid, date, numeric, bigint, bigint) to service_role;
grant execute on function public.model_allowance(uuid, date) to service_role;

comment on table public.account_plans is 'Usage plan per account (free unless set). Admin-set only; no payment integration yet.';
comment on table public.model_usage_monthly is 'Hosted-model spend per account and calendar month (UTC), as OpenRouter reports cost. Written by the hosted route.';
notify pgrst, 'reload schema';
