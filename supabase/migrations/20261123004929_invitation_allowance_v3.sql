-- Record both migrated balances and fresh grants so replay cannot restore spent requests.
create table if not exists hosted_quota_private.invitation_allowance_v3 (
  budget_key text primary key,
  recorded_at timestamptz not null default now()
);
revoke all on hosted_quota_private.invitation_allowance_v3 from public, anon, authenticated, service_role;

-- Serialize the cutover with reservations and invitation grants.
lock table public.online_dev_model_budget in exclusive mode;

create or replace function hosted_quota_private.grant_production_invitation(account_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  account_key text := 'production:account:' || account_id::text;
  pool_expiry timestamptz;
  grant_models constant text[] := array['anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash'];
begin
  if not exists (
    select 1 from auth.users
    where id=account_id and email_confirmed_at is not null and deleted_at is null
      and not coalesce(is_anonymous,false)
  ) then return false; end if;

  -- Preserve exhausted, expired and revoked grants without renewing them.
  if exists(select 1 from public.online_dev_model_budget where budget_key=account_key) then return true; end if;

  select expires_at into pool_expiry
  from public.online_dev_model_budget
  where budget_key='production:pool' and not revoked and expires_at>pg_catalog.clock_timestamp()
    and remaining_microusd>0 and remaining_requests>0 and models @> grant_models
  for share;
  if not found then return false; end if;

  insert into public.online_dev_model_budget
    (budget_key,environment,scope,singleton,user_id,models,expires_at,remaining_microusd,remaining_requests)
  values (account_key,'production','account',null,account_id,grant_models,pool_expiry,10000000,3000)
  on conflict (budget_key) do nothing;
  insert into hosted_quota_private.invitation_allowance_v3(budget_key) values (account_key)
  on conflict (budget_key) do nothing;
  return true;
end;
$$;

with newly_recorded as (
  insert into hosted_quota_private.invitation_allowance_v3 (budget_key)
  select budget_key from public.online_dev_model_budget
  where environment='production' and (scope='pool' or (scope='account' and not revoked))
  on conflict (budget_key) do nothing
  returning budget_key
)
update public.online_dev_model_budget b
set remaining_requests = case when b.scope='pool' then greatest(b.remaining_requests, 150000)
                              else least(b.remaining_requests + 2500, 1000000) end
from newly_recorded n where n.budget_key=b.budget_key;

update public.online_dev_model_budget
set models = array['anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash']
where environment='production' and scope in ('pool','account');
