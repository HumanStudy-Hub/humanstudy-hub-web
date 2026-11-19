-- Invitation allowance v2.
-- New account grants: 10,000,000 microusd and 500 requests, Haiku 5.5 only (was 5,000,000 / 100).
-- Existing live account grants get a one-time top-up of +5,000,000 microusd and +400 requests.
-- production:pool is not touched.
--
-- Idempotence: every account on the v2 allowance is recorded in a private ledger, both the
-- rows topped up here and the rows the new grant function creates. The top-up only touches
-- rows absent from the ledger and still within the old caps (<= 5,000,000 / <= 100), so a
-- repeated run, or a v2 row that was never recorded, is never topped up a second time.

create table hosted_quota_private.invitation_allowance_v2 (
  budget_key text primary key,
  recorded_at timestamptz not null default now()
);
revoke all on hosted_quota_private.invitation_allowance_v2 from public, anon, authenticated, service_role;

create or replace function hosted_quota_private.grant_production_invitation(account_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  account_key text := 'production:account:' || account_id::text;
  pool_expiry timestamptz;
  launch_model constant text := 'anthropic/claude-haiku-5.5';
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
    and remaining_microusd>0 and remaining_requests>0 and launch_model=any(models)
  for share;
  if not found then return false; end if;

  insert into public.online_dev_model_budget
    (budget_key,environment,scope,singleton,user_id,models,expires_at,remaining_microusd,remaining_requests)
  values (account_key,'production','account',null,account_id,array[launch_model],pool_expiry,10000000,500)
  on conflict (budget_key) do nothing;
  insert into hosted_quota_private.invitation_allowance_v2(budget_key) values (account_key)
  on conflict (budget_key) do nothing;
  return true;
end;
$$;

with topped as (
  update public.online_dev_model_budget b
  set remaining_microusd = b.remaining_microusd + 5000000,
      remaining_requests = b.remaining_requests + 400
  where b.scope='account' and b.environment='production' and b.budget_key like 'production:account:%'
    and not b.revoked and b.expires_at > pg_catalog.clock_timestamp()
    and b.remaining_microusd <= 5000000 and b.remaining_requests <= 100
    and not exists (select 1 from hosted_quota_private.invitation_allowance_v2 l where l.budget_key=b.budget_key)
  returning b.budget_key
)
insert into hosted_quota_private.invitation_allowance_v2(budget_key)
select budget_key from topped
on conflict (budget_key) do nothing;
