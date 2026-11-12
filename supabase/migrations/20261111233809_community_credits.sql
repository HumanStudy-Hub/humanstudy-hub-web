-- Service-only tables. Public pages expose names and aggregates through server code.
create table public.community_contributors (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200)
);

create table public.community_credits (
  id uuid primary key references public.contributions(id) on delete cascade,
  contributor_id uuid not null references public.community_contributors(id) on delete cascade,
  paper_id text not null check (paper_id ~ '^paper_[a-f0-9]{24}$'),
  paper_title text not null check (char_length(btrim(paper_title)) between 1 and 500),
  revision text not null check (revision ~ '^[a-f0-9]{64}$'),
  bench_commit text not null check (bench_commit ~ '^[a-f0-9]{40}$')
);
create index community_credits_paper_idx on public.community_credits (paper_id, revision);
create index community_credits_contributor_idx on public.community_credits (contributor_id);

create table public.community_helpful_votes (
  credit_id uuid not null references public.community_credits(id) on delete cascade,
  voter_id uuid not null references auth.users(id) on delete cascade,
  primary key (credit_id, voter_id)
);
create index community_helpful_voter_idx on public.community_helpful_votes (voter_id);

alter table public.community_contributors enable row level security;
alter table public.community_credits enable row level security;
alter table public.community_helpful_votes enable row level security;
revoke all on public.community_contributors, public.community_credits, public.community_helpful_votes from public, anon, authenticated, service_role;
grant select, insert on public.community_contributors, public.community_credits to service_role;
grant select, insert, delete on public.community_helpful_votes to service_role;

create view public.community_credit_totals with (security_invoker = true) as
select c.id, c.paper_id, c.paper_title, c.revision, p.id as contributor_id,
       p.display_name, s.created_at as submitted_at, count(v.voter_id) as helpful
from public.community_credits c
join public.community_contributors p on p.id = c.contributor_id
join public.contributions s on s.id = c.id
left join public.community_helpful_votes v on v.credit_id = c.id
group by c.id, p.id, s.id;

create view public.community_contributor_totals with (security_invoker = true) as
select contributor_id as id, display_name, count(*) as contributions, sum(helpful)::bigint as helpful
from public.community_credit_totals
group by contributor_id, display_name;

revoke all on public.community_credit_totals, public.community_contributor_totals from public, anon, authenticated;
grant select on public.community_credit_totals, public.community_contributor_totals to service_role;
grant select on public.contributions to service_role;

-- The service calls this only after checking the corresponding pinned Bench review and current revision.
create function public.register_community_credit(
  submission_id uuid, accepted_paper text, accepted_title text, accepted_revision text,
  source_commit text, public_name text
) returns void language plpgsql security invoker set search_path = '' as $$
declare
  account uuid;
  public_id uuid;
begin
  select owner_id into strict account from public.contributions where id = submission_id;
  insert into public.community_contributors(owner_id, display_name)
    values (account, public_name) on conflict (owner_id) do nothing;
  select id into strict public_id from public.community_contributors where owner_id = account;
  insert into public.community_credits(id, contributor_id, paper_id, paper_title, revision, bench_commit)
    values (submission_id, public_id, accepted_paper, accepted_title, accepted_revision, source_commit)
    on conflict (id) do nothing;
end
$$;

create function public.set_community_helpful(
  submission_id uuid, accepted_revision text, account uuid, desired boolean default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  owner uuid;
begin
  select p.owner_id into owner from public.community_credits c
    join public.community_contributors p on p.id = c.contributor_id
    where c.id = submission_id and c.revision = accepted_revision;
  if not found then return null; end if;

  if desired is not null and owner <> account then
    if desired then
      insert into public.community_helpful_votes(credit_id, voter_id)
        values (submission_id, account) on conflict do nothing;
    else
      delete from public.community_helpful_votes where credit_id = submission_id and voter_id = account;
    end if;
  end if;

  return (select jsonb_build_object(
    'helpful', count(*),
    'voted', coalesce(bool_or(voter_id = account), false),
    'canVote', owner <> account
  ) from public.community_helpful_votes where credit_id = submission_id);
end
$$;

revoke execute on function public.register_community_credit(uuid, text, text, text, text, text),
  public.set_community_helpful(uuid, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.register_community_credit(uuid, text, text, text, text, text),
  public.set_community_helpful(uuid, text, uuid, boolean) to service_role;
