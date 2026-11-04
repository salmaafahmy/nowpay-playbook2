-- =====================================================================
-- NowPay Knowledge Portal — public read-only access + PIN-protected writes
-- Branch: feature/supabase-auth-editor
--
-- What this does
--   1. kb_data   : everyone (anon + authenticated) can SELECT. Nobody can write
--                  through the public API. Writes happen only inside the
--                  `kb-editor` Edge Function, which uses the server-side secret key.
--   2. kb_data_backups : every write first copies the previous content here.
--   3. kb_pin_attempts : failed-PIN counters used for rate limiting.
--   4. kb_apply_write / kb_pin_*  : server-only functions (EXECUTE only for service_role).
--
-- It NEVER deletes, truncates or rewrites rows of kb_data. The only destructive
-- statement is dropping the old RLS *policies* on kb_data (section 1), which is
-- required so that no old "authenticated can write" policy survives.
-- Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Table (already exists in your project; created only if missing)
-- ---------------------------------------------------------------------
create table if not exists public.kb_data (
  id         text primary key,
  content    jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 1. kb_data: public READ-ONLY
-- ---------------------------------------------------------------------
alter table public.kb_data enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'kb_data' loop
    execute format('drop policy %I on public.kb_data', p.policyname);
  end loop;
end $$;

create policy kb_data_public_read on public.kb_data
  for select to anon, authenticated using (true);

-- Defense in depth: even if a write policy is added by mistake later, the role has no privilege.
revoke insert, update, delete, truncate on public.kb_data from anon, authenticated;
grant  select on public.kb_data to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Automatic backups (one row per write; content = value BEFORE the change)
-- ---------------------------------------------------------------------
create table if not exists public.kb_data_backups (
  id             bigint generated always as identity primary key,
  group_id       text        not null,
  content        jsonb,                 -- previous content (null when the group had no row yet)
  row_updated_at timestamptz,           -- updated_at of the row that was backed up
  action         text        not null,  -- short label of the edit, e.g. "edit-item"
  actor          text,                  -- salted hash of the editor's IP (no raw IPs stored)
  created_at     timestamptz not null default now()
);
create index if not exists kb_data_backups_group_idx on public.kb_data_backups (group_id, id desc);

alter table public.kb_data_backups enable row level security;   -- no policies = no public access
revoke all on public.kb_data_backups from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. PIN attempt counters (rate limiting)
-- ---------------------------------------------------------------------
create table if not exists public.kb_pin_attempts (
  bucket       text primary key,        -- 'ip:<salted hash>' or 'global'
  fail_count   int         not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz
);
alter table public.kb_pin_attempts enable row level security;
revoke all on public.kb_pin_attempts from anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Server-only functions
-- ---------------------------------------------------------------------

-- Atomic "backup + write" with optimistic concurrency.
--   returns status 'ok' | 'conflict' and the row's current updated_at.
create or replace function public.kb_apply_write(
  p_group    text,
  p_content  jsonb,
  p_expected timestamptz,   -- updated_at the editor based the change on (null = group has no row yet)
  p_action   text,
  p_actor    text,
  p_keep     int default 200
) returns table (status text, row_updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cur    public.kb_data%rowtype;
  new_ts timestamptz := clock_timestamp();
begin
  select * into cur from public.kb_data where id = p_group for update;

  if found then
    if p_expected is null or cur.updated_at is distinct from p_expected then
      return query select 'conflict'::text, cur.updated_at;
      return;
    end if;
    insert into public.kb_data_backups (group_id, content, row_updated_at, action, actor)
      values (p_group, cur.content, cur.updated_at, left(coalesce(p_action, 'edit'), 80), p_actor);
    update public.kb_data set content = p_content, updated_at = new_ts where id = p_group;
  else
    if p_expected is not null then
      return query select 'conflict'::text, null::timestamptz;   -- row disappeared since the editor read it
      return;
    end if;
    insert into public.kb_data_backups (group_id, content, row_updated_at, action, actor)
      values (p_group, null, null, left('create:' || coalesce(p_action, 'edit'), 80), p_actor);
    insert into public.kb_data (id, content, updated_at) values (p_group, p_content, new_ts);
  end if;

  -- keep the newest p_keep backups per group
  delete from public.kb_data_backups b
   where b.group_id = p_group
     and b.id not in (select x.id from public.kb_data_backups x where x.group_id = p_group order by x.id desc limit greatest(p_keep, 20));

  return query select 'ok'::text, new_ts;
exception when unique_violation then
  return query select 'conflict'::text, null::timestamptz;      -- two editors seeded the same new group at once
end $$;

-- Rate limiting -------------------------------------------------------
-- Every PIN attempt is counted BEFORE the PIN is checked (so a counting error can never open a bypass).
-- Is this bucket currently locked?  -> (allowed, retry_after_seconds)
create or replace function public.kb_pin_check(p_bucket text)
returns table (allowed boolean, retry_after int)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare r public.kb_pin_attempts%rowtype;
begin
  select * into r from public.kb_pin_attempts where bucket = p_bucket;
  if found and r.locked_until is not null and r.locked_until > now() then
    return query select false, ceil(extract(epoch from (r.locked_until - now())))::int;
  else
    return query select true, 0;
  end if;
end $$;

-- Count one attempt.  -> (attempts used in the current window, locked_until)
-- Attempts 1..p_max are allowed; the next one locks the bucket for p_lock_secs.
create or replace function public.kb_pin_hit(p_bucket text, p_max int, p_window_secs int, p_lock_secs int)
returns table (attempts int, locked_until timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare r public.kb_pin_attempts%rowtype;
begin
  insert into public.kb_pin_attempts as t (bucket, fail_count, window_start, locked_until)
  values (p_bucket, 1, now(), null)
  on conflict (bucket) do update set
    fail_count   = case when t.locked_until is not null and t.locked_until > now() then t.fail_count
                        when t.window_start < now() - make_interval(secs => p_window_secs) then 1
                        else t.fail_count + 1 end,
    window_start = case when t.locked_until is not null and t.locked_until > now() then t.window_start
                        when t.window_start < now() - make_interval(secs => p_window_secs) then now()
                        else t.window_start end,
    locked_until = case when t.locked_until is not null and t.locked_until > now() then t.locked_until else null end
  returning t.* into r;

  if (r.locked_until is null or r.locked_until <= now()) and r.fail_count > p_max then
    update public.kb_pin_attempts t set locked_until = now() + make_interval(secs => p_lock_secs), fail_count = 0, window_start = now()
      where t.bucket = p_bucket returning t.* into r;
  end if;

  delete from public.kb_pin_attempts d
   where d.window_start < now() - interval '1 day' and (d.locked_until is null or d.locked_until < now());

  return query select r.fail_count, r.locked_until;
end $$;

-- Successful PIN: clear that client's bucket.
create or replace function public.kb_pin_ok(p_bucket text)
returns void language sql security definer set search_path = public, pg_temp
as $$ delete from public.kb_pin_attempts where bucket = p_bucket; $$;

-- Successful PIN: give one attempt back on the shared (global) bucket.
create or replace function public.kb_pin_refund(p_bucket text)
returns void language sql security definer set search_path = public, pg_temp
as $$ update public.kb_pin_attempts set fail_count = greatest(fail_count - 1, 0) where bucket = p_bucket; $$;

-- Only the server (Edge Function, secret key) may call these.
revoke all on function public.kb_apply_write(text, jsonb, timestamptz, text, text, int) from public, anon, authenticated;
revoke all on function public.kb_pin_check(text)                                       from public, anon, authenticated;
revoke all on function public.kb_pin_hit(text, int, int, int)                          from public, anon, authenticated;
revoke all on function public.kb_pin_ok(text)                                          from public, anon, authenticated;
revoke all on function public.kb_pin_refund(text)                                      from public, anon, authenticated;
grant execute on function public.kb_apply_write(text, jsonb, timestamptz, text, text, int) to service_role;
grant execute on function public.kb_pin_check(text)                                       to service_role;
grant execute on function public.kb_pin_hit(text, int, int, int)                          to service_role;
grant execute on function public.kb_pin_ok(text)                                          to service_role;
grant execute on function public.kb_pin_refund(text)                                      to service_role;

grant select, insert, update on public.kb_data         to service_role;
grant select, insert, delete on public.kb_data_backups to service_role;
grant select, insert, update, delete on public.kb_pin_attempts to service_role;
