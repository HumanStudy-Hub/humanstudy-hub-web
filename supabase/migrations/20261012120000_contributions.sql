-- Community publishing: one row per publish request, plus the optional GitHub connection
-- that lets a user author their own pull requests. Rows are written only by the Hub server
-- with the service role; owners can read their own.
create table if not exists public.contributions (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  paper_key text not null check (char_length(paper_key) <= 300),
  folder text not null check (char_length(folder) <= 200),
  slug text not null check (char_length(slug) <= 80),
  status text not null default 'queued'
    check (status in ('queued', 'pr_open', 'checks_failed', 'changes_requested', 'merged', 'rejected')),
  pr_url text,
  pr_number integer,
  branch text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists contributions_owner_created_idx on public.contributions(owner_id, created_at desc);
create index if not exists contributions_paper_key_idx on public.contributions(paper_key);
create index if not exists contributions_pr_number_idx on public.contributions(pr_number);
alter table public.contributions enable row level security;
create policy contributions_select on public.contributions for select to authenticated
  using (owner_id = auth.uid());
-- No insert/update/delete policies: the service role bypasses RLS and is the only writer.
grant select on public.contributions to authenticated;

-- The token is sealed by the server (AES-256-GCM) before it is stored. The browser never needs
-- it, so only the login is readable by the owner; the column stays out of the grant.
create table if not exists public.github_identities (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  login text not null,
  token_encrypted text not null,
  scopes text not null default '',
  connected_at timestamptz not null default now()
);
alter table public.github_identities enable row level security;
create policy github_identities_select on public.github_identities for select to authenticated
  using (owner_id = auth.uid());
revoke all on public.github_identities from authenticated;
grant select (owner_id, login, scopes, connected_at) on public.github_identities to authenticated;
