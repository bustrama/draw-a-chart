-- draw-a-chart: drawings persistence and sync.
--
-- Model: one row per drawing (client-generated UUID), soft-deleted via tombstones so that
-- deletions propagate to offline devices. Clients may only READ their own rows directly; all
-- writes go through apply_drawing_changes(), which enforces ownership, optimistic concurrency
-- (rev compare-and-swap), idempotent retries (op_id) and a per-user quota, so rev/owner cannot
-- be tampered with.

create table if not exists public.drawings (
  id          uuid primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  provider    text not null check (char_length(provider) between 1 and 32),
  symbol      text not null check (char_length(symbol) between 1 and 32),
  timeframe   text not null check (char_length(timeframe) between 1 and 8),
  kind        text not null check (kind in ('ink', 'line', 'glyph')),
  data        jsonb not null default '{}'::jsonb check (octet_length(data::text) < 262144),
  deleted     boolean not null default false,
  rev         integer not null default 1 check (rev >= 1),
  last_op_id  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.drawings is 'Vector chart drawings (chart-space coordinates), one row per drawing; tombstoned on delete.';

create index if not exists drawings_user_chart_updated_idx
  on public.drawings (user_id, provider, symbol, timeframe, updated_at);

alter table public.drawings enable row level security;

drop policy if exists "drawings: owner can read" on public.drawings;
create policy "drawings: owner can read"
  on public.drawings for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- No insert/update/delete policies: direct writes are denied; use the RPC below.

-- Table privileges, explicit either way: new Supabase projects no longer grant the API roles
-- access to new tables (reads would fail with "permission denied"), while older projects grant
-- them everything by default. Signed-in users may only read (RLS limits it to their own rows);
-- the secret key (server-side admin tools only, never in the browser) gets full access.
revoke all on table public.drawings from anon, authenticated;
grant select on table public.drawings to authenticated;
grant all on table public.drawings to service_role;

-- Each element of `changes`:
--   { id, op_id, base_rev, prev_op_ids?, provider, symbol, timeframe, kind, data, deleted }
-- prev_op_ids: this client's earlier op ids for the same drawing that were sent but never
-- acknowledged (lost responses). If the row was last written by one of them, the row is the
-- client's own earlier state, so the new change applies on top of it instead of conflicting.
--
-- Per-change result: applied | duplicate | conflict | rejected | invalid (malformed/oversized;
-- reported per change so one bad change cannot block the rest of a batch).
create or replace function public.apply_drawing_changes(changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid     uuid := auth.uid();
  c       jsonb;
  cur     public.drawings%rowtype;
  results jsonb := '[]'::jsonb;
  v_id    uuid;
  v_op    uuid;
  v_base  integer;
  v_del   boolean;
  v_prev  uuid[];
  v_rows  integer;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if jsonb_typeof(changes) is distinct from 'array' then
    raise exception 'changes must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(changes) > 200 then
    raise exception 'too many changes in one call (max 200)' using errcode = '22023';
  end if;

  -- Defence in depth for a personal project whose sign-ups might be left open.
  select count(*) into v_rows from public.drawings d where d.user_id = uid;
  if v_rows + jsonb_array_length(changes) > 100000 then
    raise exception 'drawing quota exceeded' using errcode = '53400';
  end if;

  for c in select value from jsonb_array_elements(changes) loop
    begin
      v_id   := (c ->> 'id')::uuid;
      v_op   := (c ->> 'op_id')::uuid;
      v_base := coalesce((c ->> 'base_rev')::integer, 0);
      v_del  := coalesce((c ->> 'deleted')::boolean, false);
      v_prev := array(
        select jsonb_array_elements_text(
          case when jsonb_typeof(c -> 'prev_op_ids') = 'array' then c -> 'prev_op_ids' else '[]'::jsonb end
        )::uuid
      );
      if cardinality(v_prev) > 16 then
        raise exception 'too many prev_op_ids (max 16)' using errcode = '22023';
      end if;

      select * into cur from public.drawings d where d.id = v_id for update;

      if not found then
        insert into public.drawings (id, user_id, provider, symbol, timeframe, kind, data, deleted, rev, last_op_id)
        values (v_id, uid, c ->> 'provider', c ->> 'symbol', c ->> 'timeframe', c ->> 'kind',
                coalesce(c -> 'data', '{}'::jsonb), v_del, 1, v_op)
        returning * into cur;
        results := results || jsonb_build_object('id', v_id, 'status', 'applied', 'row', to_jsonb(cur) - 'user_id' - 'last_op_id');
      elsif cur.user_id is distinct from uid then
        -- Someone else's id (collision or probing): refuse without revealing anything.
        results := results || jsonb_build_object('id', v_id, 'status', 'rejected', 'row', null);
      elsif cur.last_op_id = v_op then
        -- Retry of a change that was already applied (response was lost).
        results := results || jsonb_build_object('id', v_id, 'status', 'duplicate', 'row', to_jsonb(cur) - 'user_id' - 'last_op_id');
      elsif cur.rev = v_base or cur.last_op_id = any (v_prev) then
        update public.drawings d
           set kind       = coalesce(c ->> 'kind', d.kind),
               data       = case when v_del then d.data else coalesce(c -> 'data', d.data) end,
               deleted    = v_del,
               rev        = d.rev + 1,
               last_op_id = v_op,
               updated_at = now()
         where d.id = v_id
        returning * into cur;
        results := results || jsonb_build_object('id', v_id, 'status', 'applied', 'row', to_jsonb(cur) - 'user_id' - 'last_op_id');
      else
        -- Concurrent edit from another device: the server version wins; the client adopts it.
        results := results || jsonb_build_object('id', v_id, 'status', 'conflict', 'row', to_jsonb(cur) - 'user_id' - 'last_op_id');
      end if;
    exception
      when data_exception or integrity_constraint_violation then
        -- Malformed or oversized change: report it and continue with the rest of the batch.
        results := results || jsonb_build_object('id', c ->> 'id', 'status', 'invalid', 'row', null, 'error', sqlerrm);
    end;
  end loop;

  return results;
end;
$$;

revoke all on function public.apply_drawing_changes(jsonb) from public;
revoke all on function public.apply_drawing_changes(jsonb) from anon;
grant execute on function public.apply_drawing_changes(jsonb) to authenticated;

-- Realtime (only on Supabase; skipped on plain Postgres).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'drawings'
     ) then
    execute 'alter publication supabase_realtime add table public.drawings';
  end if;
end;
$$;

-- Private broadcast channel "preview:<user id>" for live stroke previews between the user's devices.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'realtime')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'realtime' and c.relname = 'messages') then
    execute 'drop policy if exists "preview: owner can receive" on realtime.messages';
    execute $p$
      create policy "preview: owner can receive" on realtime.messages
        for select to authenticated
        using ((select realtime.topic()) = 'preview:' || (select auth.uid())::text
               and realtime.messages.extension = 'broadcast')
    $p$;
    execute 'drop policy if exists "preview: owner can send" on realtime.messages';
    execute $p$
      create policy "preview: owner can send" on realtime.messages
        for insert to authenticated
        with check ((select realtime.topic()) = 'preview:' || (select auth.uid())::text
                    and realtime.messages.extension = 'broadcast')
    $p$;
  end if;
end;
$$;
