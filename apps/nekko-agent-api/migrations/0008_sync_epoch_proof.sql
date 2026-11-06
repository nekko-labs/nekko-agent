-- Proof of the epoch key (docs/SYNC-ENCRYPTION.md, "What Nekko Cloud enforces").
--
-- sync_keyrings.proof_hash: SHA-256 of the epoch proof, a one-way value the
--   devices derive from the epoch's keyring (crates/nekko-sync epoch_proof).
--   The server can check a proof against it but can derive no key from it. A
--   keyring without one never makes a token count as holding its keys.
-- api_tokens.sync_proven_key_id: the key epoch this token last proved it holds.
--   A token counts as keyed only for the current epoch it proved, on a device
--   that has a wrap for it.

alter table sync_keyrings add column proof_hash bytea check (octet_length(proof_hash) = 32);
alter table api_tokens add column sync_proven_key_id integer;
