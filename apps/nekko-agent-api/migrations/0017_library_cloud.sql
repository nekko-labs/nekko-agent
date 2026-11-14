-- Library on Nekko Cloud (issues #2749 and #2750). Everything stored here is
-- ciphertext the service can't open: a synced Library record is sealed with the
-- account's sync keys, a shared file with a key that lives only in its link.

-- Earlier revisions of synced Library records, kept for 30 days after they
-- were replaced, so a file can be taken back to a version or brought back
-- after a delete (a delete is a sealed tombstone revision like any other).
create table sync_object_history (
  user_id        uuid not null references users (id) on delete cascade,
  collection     text not null,
  object_id      text not null,
  revision       bigint not null check (revision >= 1),
  key_id         integer not null,
  blob           bytea not null,
  superseded_at  timestamptz not null default now(),
  primary key (user_id, collection, object_id, revision)
);
create index sync_object_history_superseded on sync_object_history (superseded_at);

-- A shared file: its sealed bytes, served to anyone with its id. The key is
-- in the link's #fragment and never reaches the service. Deleting it only
-- stamps deleted_at for 30 days (the link stops working at once); after that,
-- or when deleted for good, the row and its versions go.
create table library_shares (
  id          text primary key check (id ~ '^[A-Za-z0-9_-]{22}$'),
  user_id     uuid not null references users (id) on delete cascade,
  revision    integer not null default 1 check (revision >= 1),
  blob        bytea not null,
  -- SHA-256 of the "can edit" token an edit link carries; null: view only.
  edit_hash   bytea check (edit_hash is null or octet_length(edit_hash) = 32),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index library_shares_user on library_shares (user_id, updated_at desc);
create index library_shares_deleted on library_shares (deleted_at) where deleted_at is not null;

-- Earlier versions of a shared file, kept for 30 days after they were replaced.
create table library_share_versions (
  share_id       text not null references library_shares (id) on delete cascade,
  revision       integer not null check (revision >= 1),
  blob           bytea not null,
  superseded_at  timestamptz not null default now(),
  primary key (share_id, revision)
);
create index library_share_versions_superseded on library_share_versions (superseded_at);
