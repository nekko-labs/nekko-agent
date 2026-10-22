-- Trust model v2 (docs/decisions/0007): joining by a typed code.
--
-- sync_devices.join_tag: HMAC(code-derived key, account ‖ public key) that a
--   device asking to join publishes. The approving device recomputes it from the
--   code the user types, so a public key swapped in by anyone else is refused.
--   The code itself never reaches the server.

alter table sync_devices add column join_tag bytea check (octet_length(join_tag) = 32);
