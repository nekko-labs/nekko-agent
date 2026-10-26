package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant

// Git on a chat's folder from the phone (AN-30, the iPhone's IO-33 FA-2), as
// the computer projects it for phones (packages/shared/src/phone-git.ts):
// status, diffs, history, branches and compare to read; stage, commit, a
// model-written message, push, switch and abort a merge as Change actions
// (signed: the fingerprint, face or screen lock). Mirrors `Git.swift`.
//
// A phone always names the chat (`session:<chatId>`), never a folder: the
// computer refuses anything else. Paths are relative to the chat's folder.
// Commits carry the author's name, never their email; a secret-looking file
// is listed with `hidden` and no patch.

/** One git call from the phone: the channel and the exact arguments sent (and, for a Change, signed). */
data class GitRequest(val channel: String, val args: List<JsonElement>) {
    /** Whether the computer treats it as a Change (`PHONE_CHANGE_CHANNELS`). */
    val isChange: Boolean get() = channel in Channels.GIT_CHANGE

    companion object {
        /** The workspace a phone names: the chat's own checkout. */
        fun folder(chatId: String) = JsonPrimitive("session:$chatId")

        fun status(chat: String, refresh: Boolean = false) =
            GitRequest(Channels.WORKSPACE_GIT_STATUS, listOf(folder(chat), JsonPrimitive(refresh)))

        /** Unstaged changes with new files, or what is staged. */
        fun diff(chat: String, staged: Boolean, path: String? = null, base: String? = null) =
            GitRequest(Channels.GIT_DIFF, listOf(folder(chat), buildJsonObject {
                put("staged", staged)
                path?.let { put("path", it) }
                base?.let { put("base", it) }
            }))

        fun log(chat: String, limit: Int = 50, skip: Int = 0, ref: String? = null) =
            GitRequest(Channels.GIT_LOG, listOf(folder(chat), buildJsonObject {
                put("limit", limit)
                put("skip", skip)
                ref?.let { put("ref", it) }
            }))

        fun show(chat: String, rev: String) = GitRequest(Channels.GIT_SHOW, listOf(folder(chat), JsonPrimitive(rev)))

        fun branches(chat: String) = GitRequest(Channels.GIT_BRANCHES, listOf(folder(chat)))

        fun compare(chat: String, base: String, head: String) =
            GitRequest(Channels.GIT_COMPARE, listOf(folder(chat), JsonPrimitive(base), JsonPrimitive(head)))

        fun stage(chat: String, paths: List<String>) =
            GitRequest(Channels.GIT_STAGE, listOf(folder(chat), JsonArray(paths.map(::JsonPrimitive))))

        fun unstage(chat: String, paths: List<String>) =
            GitRequest(Channels.GIT_UNSTAGE, listOf(folder(chat), JsonArray(paths.map(::JsonPrimitive))))

        fun commit(chat: String, message: String) =
            GitRequest(Channels.GIT_COMMIT, listOf(folder(chat), buildJsonObject { put("message", message) }))

        /** A message for what is staged, written by the computer's model (spends its tokens). */
        fun commitMessage(chat: String) = GitRequest(Channels.GIT_COMMIT_MESSAGE, listOf(folder(chat)))

        /** Push the current branch; publishes it to its remote first if it has no upstream yet. */
        fun push(chat: String) = GitRequest(Channels.GIT_PUSH, listOf(folder(chat), buildJsonObject { put("setUpstream", true) }))

        fun switchBranch(chat: String, name: String, create: Boolean = false) =
            GitRequest(Channels.GIT_SWITCH, listOf(folder(chat), JsonPrimitive(name), buildJsonObject { put("create", create) }))

        fun mergeAbort(chat: String) = GitRequest(Channels.GIT_MERGE_ABORT, listOf(folder(chat)))
    }
}

/** A chat folder's git position (`workspace:gitStatus`). */
data class GitStatus(
    val repo: Boolean,
    val branch: String? = null,
    /** Short sha of HEAD: all a detached HEAD has. */
    val head: String? = null,
    val dirtyCount: Int = 0,
    val ahead: Int = 0,
    val behind: Int = 0,
    /** The linked worktree's folder name, when the chat works in one. */
    val worktree: String? = null,
) {
    /** `main`, or `detached at abc1234`. */
    val position: String get() = branch ?: head?.let { "detached at $it" } ?: "no commits yet"

    /** `2 to push · 1 to pull`, or null when level with its upstream. */
    val drift: String?
        get() = listOfNotNull(
            if (ahead > 0) "$ahead to push" else null,
            if (behind > 0) "$behind to pull" else null,
        ).joinToString(" · ").ifEmpty { null }

    companion object {
        fun from(v: JsonElement?): GitStatus? {
            val o = v.obj() ?: return null
            return GitStatus(
                repo = o.bool("repo"), branch = o.str("branch"), head = o.str("head"),
                dirtyCount = o.long("dirtyCount")?.toInt() ?: 0, ahead = o.long("ahead")?.toInt() ?: 0,
                behind = o.long("behind")?.toInt() ?: 0, worktree = o["worktree"].obj()?.str("name"),
            )
        }
    }
}

/** One file of a diff, a commit or a compare. */
data class GitFile(
    val path: String,
    val oldPath: String? = null,
    val status: Status = Status.MODIFIED,
    val additions: Int = 0,
    val deletions: Int = 0,
    val binary: Boolean = false,
    /** A new file git doesn't track yet. */
    val untracked: Boolean = false,
    /** The patch was cut (too long for a phone, or past the answer's size cap). */
    val truncated: Boolean = false,
    /** May hold secrets: listed, never shown on a phone. */
    val hidden: Boolean = false,
    val hunks: List<PhoneChanges.Hunk> = emptyList(),
) {
    enum class Status(val wire: String) { ADDED("added"), REMOVED("removed"), MODIFIED("modified"), RENAMED("renamed"), CONFLICTED("conflicted") }

    /** The letter a status list shows. */
    val mark: String
        get() = if (untracked) "?" else when (status) {
            Status.ADDED -> "A"
            Status.REMOVED -> "D"
            Status.MODIFIED -> "M"
            Status.RENAMED -> "R"
            Status.CONFLICTED -> "U"
        }

    companion object {
        /**
         * Unified-diff hunks from git's patch text (from the first `@@`), in the
         * shape the Changes view draws. `\ No newline` notes are dropped.
         */
        fun hunks(patch: String): List<PhoneChanges.Hunk> {
            val out = mutableListOf<PhoneChanges.Hunk>()
            var start: Pair<Int, Int>? = null
            val lines = mutableListOf<String>()
            fun flush() {
                start?.let { (o, n) -> out += PhoneChanges.Hunk.of(o, n, lines.toList()) }
                lines.clear()
            }
            for (raw in patch.split("\n")) {
                val line = raw.removeSuffix("\r")
                if (line.startsWith("@@")) {
                    flush()
                    start = header(line)
                } else if (start != null && line.isNotEmpty() && line[0] in " +-") {
                    lines += line
                }
            }
            flush()
            return out
        }

        /** `@@ -12,3 +14,4 @@ fn x` → (12, 14). */
        internal fun header(line: String): Pair<Int, Int>? {
            val parts = line.split(" ").filter { it.isNotEmpty() }
            if (parts.size < 3 || !parts[1].startsWith("-") || !parts[2].startsWith("+")) return null
            fun start(s: String) = s.drop(1).split(",").first().toIntOrNull()
            val o = start(parts[1]) ?: return null
            val n = start(parts[2]) ?: return null
            return o to n
        }

        fun from(v: JsonElement): GitFile? {
            val f = v.obj() ?: return null
            val path = f.str("path") ?: return null
            val hidden = f.bool("hidden")
            return GitFile(
                path = path, oldPath = f.str("oldPath"),
                status = Status.entries.firstOrNull { it.wire == f.str("status") } ?: Status.MODIFIED,
                additions = f.long("additions")?.toInt() ?: 0, deletions = f.long("deletions")?.toInt() ?: 0,
                binary = f.bool("binary"), untracked = f.bool("untracked"), truncated = f.bool("truncated"), hidden = hidden,
                hunks = if (hidden) emptyList() else hunks(f.str("patch").orEmpty()),
            )
        }
    }
}

/** A diff as a phone receives it (`git:diff`, a commit's files, a compare's). */
data class GitDiff(
    val files: List<GitFile> = emptyList(),
    val truncated: Boolean = false,
    /** Files past the phone's limit, not listed. */
    val omittedFiles: Int = 0,
    /** Listed files whose patch is withheld because they may hold secrets. */
    val hiddenFiles: Int = 0,
) {
    val additions: Int get() = files.sumOf { it.additions }
    val deletions: Int get() = files.sumOf { it.deletions }

    companion object {
        fun from(v: JsonElement?): GitDiff {
            val o = v.obj() ?: return GitDiff()
            return GitDiff(
                files = o["files"].arr().orEmpty().mapNotNull(GitFile::from), truncated = o.bool("truncated"),
                omittedFiles = o.long("omittedFiles")?.toInt() ?: 0, hiddenFiles = o.long("hiddenFiles")?.toInt() ?: 0,
            )
        }
    }
}

/** One commit: the author's name, never their email. */
data class GitCommit(
    val sha: String,
    val short: String = sha.take(7),
    val parents: List<String> = emptyList(),
    val author: String = "",
    /** Author date, ISO 8601. */
    val date: String = "",
    val subject: String = "",
    /** Only in a commit's detail (`git:show`). */
    val body: String? = null,
) {
    val isMerge: Boolean get() = parents.size > 1

    /** Milliseconds since the epoch, or null when the date doesn't read. */
    val whenMs: Long? get() = runCatching { java.time.OffsetDateTime.parse(date).toInstant().toEpochMilli() }.getOrNull()
        ?: runCatching { Instant.parse(date).toEpochMilli() }.getOrNull()

    companion object {
        fun from(v: JsonElement): GitCommit? {
            val c = v.obj() ?: return null
            val sha = c.str("sha") ?: return null
            return GitCommit(
                sha = sha, short = c.str("short") ?: sha.take(7),
                parents = c["parents"].arr().orEmpty().mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content },
                author = c.str("author").orEmpty(), date = c.str("date").orEmpty(), subject = c.str("subject").orEmpty(), body = c.str("body"),
            )
        }

        fun list(v: JsonElement?): List<GitCommit> = v.arr().orEmpty().mapNotNull(::from)
    }
}

/** A commit and its changes (`git:show`). */
data class GitCommitDetail(val commit: GitCommit, val diff: GitDiff) {
    companion object {
        fun from(v: JsonElement?): GitCommitDetail? {
            val c = v.obj()?.get("commit")?.let(GitCommit::from) ?: return null
            return GitCommitDetail(c, GitDiff.from(v))
        }
    }
}

data class GitBranch(
    /** `main` locally, `origin/main` for a remote one. */
    val name: String,
    val sha: String = "",
    val subject: String = "",
    val current: Boolean = false,
    val upstream: String? = null,
    val ahead: Int = 0,
    val behind: Int = 0,
    /** The upstream was deleted on the remote. */
    val gone: Boolean = false,
    val remote: String? = null,
) {
    /** The local name a remote branch switches to: `origin/feat` → `feat`. */
    val localName: String
        get() = if (remote != null && name.startsWith("$remote/")) name.removePrefix("$remote/") else name

    companion object {
        fun from(v: JsonElement): GitBranch? {
            val b = v.obj() ?: return null
            val name = b.str("name") ?: return null
            return GitBranch(
                name = name, sha = b.str("sha").orEmpty(), subject = b.str("subject").orEmpty(), current = b.bool("current"),
                upstream = b.str("upstream"), ahead = b.long("ahead")?.toInt() ?: 0, behind = b.long("behind")?.toInt() ?: 0,
                gone = b.bool("gone"), remote = b.str("remote"),
            )
        }
    }
}

/** Local and remote branches (`git:branches`). */
data class GitBranches(
    val current: String? = null,
    val detached: Boolean = false,
    val defaultBranch: String? = null,
    val local: List<GitBranch> = emptyList(),
    val remote: List<GitBranch> = emptyList(),
    val omitted: Int = 0,
) {
    /** Remote branches with no local branch of the same name: switching to one makes it. */
    val remoteOnly: List<GitBranch>
        get() {
            val names = local.map { it.name }.toSet()
            return remote.filter { it.localName !in names && it.localName != "HEAD" }
        }

    /** What compare starts from: the remote's default branch, else `main`. */
    val compareBase: String
        get() = defaultBranch ?: if (local.any { it.name == "main" }) "main" else local.firstOrNull()?.name ?: "main"

    companion object {
        fun from(v: JsonElement?): GitBranches {
            val o = v.obj() ?: return GitBranches()
            return GitBranches(
                current = o.str("current"), detached = o.bool("detached"), defaultBranch = o.str("defaultBranch"),
                local = o["local"].arr().orEmpty().mapNotNull(GitBranch::from),
                remote = o["remote"].arr().orEmpty().mapNotNull(GitBranch::from),
                omitted = ((o.long("omittedLocal") ?: 0) + (o.long("omittedRemote") ?: 0)).toInt(),
            )
        }
    }
}

/** How `head` differs from `base` (`git:compare`). */
data class GitCompare(val base: String, val head: String, val ahead: Int, val behind: Int, val commits: List<GitCommit>, val diff: GitDiff) {
    companion object {
        fun from(v: JsonElement?): GitCompare? {
            val o = v.obj() ?: return null
            val base = o.str("base") ?: return null
            val head = o.str("head") ?: return null
            return GitCompare(base, head, o.long("ahead")?.toInt() ?: 0, o.long("behind")?.toInt() ?: 0, GitCommit.list(o["commits"]), GitDiff.from(o))
        }
    }
}

/** What a git change answers: `ok: false` carries git's own reason. */
data class GitResult(
    val ok: Boolean,
    val message: String,
    val branch: String? = null,
    val upstream: String? = null,
    val commit: GitCommit? = null,
) {
    companion object {
        fun from(v: JsonElement?): GitResult {
            val o = v as? JsonObject ?: return GitResult(false, "Your computer didn’t answer.")
            return GitResult(o.bool("ok"), o.str("message").orEmpty(), o.str("branch"), o.str("upstream"), o["commit"]?.let(GitCommit::from))
        }
    }
}

/** A commit message the computer's model wrote for what is staged. */
data class GitCommitMessage(val message: String, /** The staged diff was cut before the model saw it. */ val inputTruncated: Boolean) {
    companion object {
        fun from(v: JsonElement?): GitCommitMessage? {
            val o = v.obj() ?: return null
            val m = o.str("message")?.takeIf { it.isNotEmpty() } ?: return null
            return GitCommitMessage(m, o.bool("inputTruncated"))
        }
    }
}
