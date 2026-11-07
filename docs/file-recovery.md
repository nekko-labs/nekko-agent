# Recover AI file edits and validate batch replacements

Nekko Agent's **Changes** (file review) shows original and current text for files changed by its native file tools. You can review an edit before keeping it or undoing it. Saved-chat recovery adds local originals that survive an app restart; batch editing validates several replacements before writing a file.

**Availability:** durable originals and `edit_file.edits` are new source capabilities in [PR #2193](https://github.com/nekko-labs/nekko-agent/pull/2193). Check that the change is merged and included in your build; this page does not assert that every published installer contains it. See [releases](https://github.com/nekko-labs/nekko-agent/releases) and the [implementation specification](https://github.com/nekko-labs/nekko-agent/blob/main/spec/code/recoverable-file-edits.md).

## How do I review or undo an AI file edit?

1. Work in a **saved chat** with your project folder added. Ask the agent to use Nekko's native file tools for the edit.
2. Open **Changes** and compare the original with the current file. Read the diff before choosing to keep or undo it.
3. To undo, choose **Revert file** while the original is still retained. To keep it and clear that baseline, choose **Keep** (or **Keep all** for all files).
4. If you restart a build with durable recovery, reopen the same saved chat: its original text remains available for review.

Accepting a change **discards its saved original**. It is not a Git commit or a backup. Keep version control and backups for important work, and avoid undoing over newer changes made by someone else.

## What survives a restart?

The first original text recorded for each path in a saved chat survives restart. Further native edits in the same review cycle retain that original rather than replacing it with an already edited version. The current side of the diff is read from disk.

| Situation | What happens to the original |
| --- | --- |
| Saved chat, before the first native write/edit | Original must be saved locally before the tool mutates the file |
| Restart and reopen the saved chat | Retained original loads again for review |
| Accept one change / accept all | Corresponding originals are discarded |
| Delete the chat / wipe app data | Associated recovery data is removed |
| Switch a saved chat to incognito | Its persisted originals are discarded |
| Incognito chat | Originals stay in memory only and do not survive restart |

## Are recovery snapshots private or synced?

Originals live under the app's local data directory in `changes/<chat-id>.json`. They can contain private source text. They are **not encrypted by this feature** and are not included in chat sync. Unix sidecars are created with owner-only permissions; Windows relies on the data directory's access controls, not a new per-file ACL policy.

Incognito controls Nekko's chat/recovery persistence. It does not erase files already written in your workspace, hide terminal activity from the operating system or change an online provider's retention policy.

## What if an original cannot be saved?

The native write or edit fails **before mutation** rather than silently continuing without recovery. Unreadable session policy, corrupt snapshots, storage errors and snapshot limits surface as errors. Fix the data-directory access/storage problem or review and accept changes you intentionally no longer need. Do not delete a snapshot merely to silence an error if you still need its original.

Limits are **512 paths per chat** and **64 MiB of serialized originals**. The file-read guard rejects oversized originals before reading them. Accept-all can explicitly discard a corrupt snapshot; doing so loses its recovery content.

## How do batch file edits work?

An agent can call `edit_file` with a path and **1–100 ordered literal replacements**. Each `old_string` must be nonempty and match exactly once in the evolving file text. Each `new_string` must be a string; an empty string deletes the match. Later replacements may match text produced by earlier replacements.

```json
{
  "path": "src/example.ts",
  "edits": [
    { "old_string": "const retries = 1;", "new_string": "const retries = 3;" },
    { "old_string": "const delay = 100;", "new_string": "const delay = 250;" }
  ]
}
```

All replacements validate before snapshot recording or writing. A missing or ambiguous later match leaves the file unchanged by that call. Replacements are literal, not regular expressions. Do not combine `edits` with top-level `old_string`/`new_string`. Single replacements still use those top-level fields; a missing `new_string` is an error, not the text `undefined`.

The batch uses the same approval, read-only-folder, path-containment and Git-configuration gates as a single edit. The sandbox helper validates batches too, but durable host recovery is limited to the native tool path; a valid sandbox batch is not evidence of a host snapshot.

## Is this a workspace checkpoint or an atomic transaction?

**No.** Validation prevents a partially applied *invalid replacement batch*. Snapshot recording and file writing are separate operations, and another writer or a filesystem failure can interfere. There is no cross-file transaction or per-tool-step checkpoint history.

Not covered: shell commands, external editors, MCP tools, Claude Code's own file tools, binary-perfect restoration, rename/deletion tracking, or the distinction between a newly created file and an originally empty file. Use Git and backups for those cases.

## Related guides

- [Features by task](/docs/features)
- [Context, memory and safety](/docs/context-memory-safety)
- [Verification and PR progress](/docs/chat-progress)
- [Getting started](/docs)
