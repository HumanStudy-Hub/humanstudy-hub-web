-- Called by the Hub only after successful authenticated invitation redemption.
-- Inference still requires both the production pool and the exact account grant.
create schema hosted_quota_private;
revoke all on schema hosted_quota_private from public, anon, authenticated, service_role;
grant usage on schema hosted_quota_private to service_role;

create function hosted_quota_private.grant_production_invitation(account_id uuid)
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
  values (account_key,'production','account',null,account_id,array[launch_model],pool_expiry,5000000,100)
  on conflict (budget_key) do nothing;
  return true;
end;
$$;

revoke execute on function hosted_quota_private.grant_production_invitation(uuid) from public, anon, authenticated, service_role;
grant execute on function hosted_quota_private.grant_production_invitation(uuid) to service_role;

create function public.online_grant_production_invitation(account_id uuid)
returns boolean language sql security invoker set search_path = '' as $$
  select hosted_quota_private.grant_production_invitation(account_id);
$$;
revoke execute on function public.online_grant_production_invitation(uuid) from public, anon, authenticated, service_role;
grant execute on function public.online_grant_production_invitation(uuid) to service_role;
