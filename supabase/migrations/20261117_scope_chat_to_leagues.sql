-- Scope the shared League Chat room to leagues, matching every other
-- league-scoped table. Direct messages (direct_messages/dm_reads) and the
-- Requests/Votes feature are explicitly out of scope for this migration.

do $$
declare
  v_league1_id bigint;
begin
  select id into v_league1_id from leagues order by id limit 1;

  -- 1. chat_messages gets a league_id, backfilled to League #1, then locked NOT NULL.
  alter table chat_messages add column if not exists league_id bigint references leagues(id);
  update chat_messages set league_id = v_league1_id where league_id is null;
  alter table chat_messages alter column league_id set not null;

  -- 2. New chat_reads table (mirrors dm_reads's shape) + backfill from players.last_chat_read_at.
  create table if not exists chat_reads (
    user_id uuid not null references players(id) on delete cascade,
    league_id bigint not null references leagues(id) on delete cascade,
    last_read_at timestamptz,
    primary key (user_id, league_id)
  );

  insert into chat_reads (user_id, league_id, last_read_at)
  select p.id, v_league1_id, p.last_chat_read_at
  from players p
  where p.last_chat_read_at is not null
  on conflict (user_id, league_id) do nothing;
end $$;

alter table chat_reads enable row level security;

drop policy if exists "chat_reads select own" on chat_reads;
create policy "chat_reads select own" on chat_reads
  for select using (auth.uid() = user_id);

drop policy if exists "chat_reads insert own" on chat_reads;
create policy "chat_reads insert own" on chat_reads
  for insert with check (auth.uid() = user_id);

drop policy if exists "chat_reads update own" on chat_reads;
create policy "chat_reads update own" on chat_reads
  for update using (auth.uid() = user_id);

-- 3. chat_messages RLS: readable/insertable only by members of that message's
-- league; delete switched from the global-only admin check to is_league_admin(),
-- fixing the latent bug where a per-league (non-super) admin's delete button
-- would render but fail server-side.
drop policy if exists "chat readable by all" on chat_messages;
create policy "chat readable by league members" on chat_messages
  for select using (
    exists (
      select 1 from league_members lm
      where lm.league_id = chat_messages.league_id and lm.user_id = auth.uid()
    )
  );

drop policy if exists "chat insert own messages" on chat_messages;
create policy "chat insert own messages" on chat_messages
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from league_members lm
      where lm.league_id = chat_messages.league_id and lm.user_id = auth.uid()
    )
  );

drop policy if exists "admins can delete any chat message" on chat_messages;
create policy "admins can delete any chat message" on chat_messages
  for delete using (is_league_admin(chat_messages.league_id));

-- 4. chat_reactions RLS: no league_id column needed (scoped transitively via
-- the message it reacts to). Self-insert/self-delete by the reacting user are
-- unchanged; readable-by-all and admin-delete are scoped through the message.
drop policy if exists "chat_reactions readable by all" on chat_reactions;
create policy "chat_reactions readable by league members" on chat_reactions
  for select using (
    exists (
      select 1 from chat_messages cm
      join league_members lm on lm.league_id = cm.league_id
      where cm.id = chat_reactions.message_id and lm.user_id = auth.uid()
    )
  );

drop policy if exists "chat_reactions self insert" on chat_reactions;
create policy "chat_reactions self insert" on chat_reactions
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from chat_messages cm
      join league_members lm on lm.league_id = cm.league_id
      where cm.id = chat_reactions.message_id and lm.user_id = auth.uid()
    )
  );

drop policy if exists "admins can delete any chat reactions" on chat_reactions;
create policy "admins can delete any chat reactions" on chat_reactions
  for delete using (
    exists (
      select 1 from chat_messages cm
      where cm.id = chat_reactions.message_id and is_league_admin(cm.league_id)
    )
  );

-- "chat_reactions self delete" (auth.uid() = user_id) is left untouched --
-- removing your own reaction never needed a league check.
