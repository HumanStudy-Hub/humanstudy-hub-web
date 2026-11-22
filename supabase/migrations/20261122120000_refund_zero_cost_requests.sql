create or replace function public.online_settle_account_model_budget(request_id uuid, budget_environment text, actual_microusd bigint)
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
  update public.online_dev_model_budget set remaining_microusd=remaining_microusd+refund,
    remaining_requests=remaining_requests + case when actual_microusd=0 then 1 else 0 end
    where budget_key in (pool_key,account_key);
  update public.online_model_reservations set state='settled', actual_microusd=online_settle_account_model_budget.actual_microusd,
    settled_at=clock_timestamp() where id=request_id;
  return true;
end;
$$;
revoke execute on function public.online_settle_account_model_budget(uuid,text,bigint) from public, anon, authenticated;
grant execute on function public.online_settle_account_model_budget(uuid,text,bigint) to service_role;
