package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Base64

// Files on the computer, from the phone (AN-33, the iPhone's IO-33 FA-1), as
// the computer projects them for phones (packages/shared/src/phone-files.ts):
// a chat's or saved folder's files (list, search, read; save as a Change
// action, checked against the hash the phone read). Mirrors `Files.swift`.

/** The folder a files call works in. A phone names it by id, never by path. */
sealed interface FileRoot {
    /** A chat's checkout: its worktree when isolated, else its project folder. */
    data class Chat(val sessionId: String) : FileRoot
    /** A saved folder on the computer (`workspace:list`). */
    data class Folder(val workspaceId: String) : FileRoot

    val json: JsonElement
        get() = when (this) {
            is Chat -> buildJsonObject { put("sessionId", sessionId) }
            is Folder -> buildJsonObject { put("workspaceId", workspaceId) }
        }
}

/** One call into the computer's files, ready to send. */
data class FilesRequest(val channel: String, val args: List<JsonElement>) {
    /** Saving is the only Change (`PHONE_CHANGE_CHANNELS`); the rest are reads. */
    val isChange: Boolean get() = channel == Channels.FILES_WRITE

    companion object {
        fun list(root: FileRoot, path: String = "") = FilesRequest(Channels.FILES_LIST, listOf(root.json, JsonPrimitive(path)))

        fun search(root: FileRoot, query: String, limit: Int = 50) =
            FilesRequest(Channels.FILES_SEARCH, listOf(root.json, JsonPrimitive(query), JsonPrimitive(limit)))

        fun read(root: FileRoot, path: String) = FilesRequest(Channels.FILES_READ, listOf(root.json, JsonPrimitive(path)))

        /** Replace the file, if it still has the hash the phone read. */
        fun write(root: FileRoot, path: String, content: String, expectHash: String) = FilesRequest(
            Channels.FILES_WRITE,
            listOf(root.json, JsonPrimitive(path), JsonPrimitive(content), buildJsonObject { put("expectHash", expectHash) }),
        )
    }
}

/** One entry in a folder. */
data class FileEntry(
    val name: String,
    /** Relative to the folder, `/`-separated. */
    val path: String,
    val dir: Boolean,
    val size: Long? = null,
    val mtime: Long? = null,
    val link: Boolean = false,
)

private fun lastPart(path: String) = path.trimEnd('/').substringAfterLast('/')

/** A folder's listing: folders first, then files. */
data class FileListing(
    val path: String,
    val entries: List<FileEntry>,
    /** More entries than the phone was sent. */
    val truncated: Boolean = false,
    val total: Int = entries.size,
    /** Files left out because they may hold secrets. */
    val hiddenSecrets: Int = 0,
    /** Links left out because they lead outside the folder. */
    val hiddenLinks: Int = 0,
) {
    companion object {
        fun from(v: JsonElement?): FileListing? {
            val o = v.obj() ?: return null
            val entries = o["entries"].arr().orEmpty().mapNotNull { e ->
                val f = e.obj() ?: return@mapNotNull null
                val path = f.str("path") ?: return@mapNotNull null
                FileEntry(f.str("name") ?: lastPart(path), path, f.bool("dir"), f.long("size"), f.long("mtime"), f.bool("link"))
            }
            return FileListing(
                o.str("path").orEmpty(), entries, o.bool("truncated"), o.long("total")?.toInt() ?: entries.size,
                o.long("hiddenSecrets")?.toInt() ?: 0, o.long("hiddenLinks")?.toInt() ?: 0,
            )
        }
    }
}

/** Files whose name or path matched, best first. */
data class FileSearch(
    val hits: List<FileEntry>,
    val truncated: Boolean = false,
    /** False when the computer stopped looking before the end of a very large folder. */
    val complete: Boolean = true,
) {
    companion object {
        fun from(v: JsonElement?): FileSearch {
            val o = v.obj()
            val hits = o?.get("hits").arr().orEmpty().mapNotNull { e ->
                val h = e.obj() ?: return@mapNotNull null
                val path = h.str("path") ?: return@mapNotNull null
                FileEntry(h.str("name") ?: lastPart(path), path, dir = false)
            }
            return FileSearch(hits, o?.bool("truncated") == true, o?.bool("complete") == true)
        }
    }
}

/** A file as the phone shows it. */
data class FileContent(
    val path: String,
    val name: String,
    val size: Long,
    val mtime: Long? = null,
    /** sha256 of the whole file: what a save is checked against. */
    val hash: String? = null,
    val kind: Kind,
    val text: String? = null,
    /** Only part of the file was sent. */
    val truncated: Boolean = false,
    val language: String? = null,
    val markdown: Boolean = false,
    /** Raw image bytes from the computer's data URL. */
    val image: ByteArray? = null,
    val mime: String? = null,
    /** Whole UTF-8 text the computer would let a save replace. */
    val editable: Boolean = false,
) {
    enum class Kind(val wire: String) { TEXT("text"), IMAGE("image"), BINARY("binary") }

    /** Whether this phone may offer to edit it: whole text with a hash. */
    val canEdit: Boolean get() = editable && !truncated && kind == Kind.TEXT && hash != null && text != null

    /** The text's lines, for numbered display. */
    val lines: List<String>
        get() {
            val t = text ?: return emptyList()
            val all = t.split("\n")
            return if (all.last().isEmpty()) all.dropLast(1) else all
        }

    // ByteArray compares by identity; the rest is what a file is.
    override fun equals(other: Any?): Boolean = other is FileContent && other.path == path && other.hash == hash && other.text == text &&
        other.kind == kind && other.size == size && other.truncated == truncated && other.editable == editable

    override fun hashCode(): Int = listOf(path, hash, text, kind, size).hashCode()

    companion object {
        fun from(v: JsonElement?): FileContent? {
            val o = v.obj() ?: return null
            val path = o.str("path") ?: return null
            val image = o.str("imageDataUrl")?.takeIf { it.startsWith("data:image/") }?.substringAfter(',', "")
                ?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() }
            return FileContent(
                path = path, name = o.str("name") ?: lastPart(path), size = o.long("size") ?: 0, mtime = o.long("mtime"), hash = o.str("hash"),
                kind = Kind.entries.firstOrNull { it.wire == o.str("kind") } ?: Kind.BINARY, text = o.str("content"),
                truncated = o.bool("truncated"), language = o.str("language"), markdown = o.bool("markdown"),
                image = image, mime = o.str("mime"), editable = o.bool("editable"),
            )
        }
    }
}

/** What a save came back with. */
sealed interface FileSaveResult {
    /** Saved: the file's new hash. */
    data class Saved(val hash: String) : FileSaveResult
    /** The file changed on the computer since it was read: its current hash (null when it is gone). */
    data class Conflict(val current: String?) : FileSaveResult

    companion object {
        fun from(v: JsonElement?): FileSaveResult? {
            val o = v.obj() ?: return null
            val ok = (o["ok"] as? JsonPrimitive)?.content ?: return null
            if (ok == "true") return o.str("hash")?.let(::Saved)
            if (ok == "false" && o.str("error") == "conflict") return Conflict(o.str("hash"))
            return null
        }
    }
}

/** The computer's files errors start with a code (`not-found: no such chat`); this says them plainly. */
object FilesError {
    private val CODES = setOf("outside-root", "secret-file", "not-found", "not-a-file", "not-a-folder", "no-folder", "binary", "too-large", "bad-request", "io")

    fun plain(message: String): String {
        val colon = message.indexOf(": ")
        if (colon < 0) return message
        val code = message.substring(0, colon)
        if (code !in CODES) return message
        val rest = message.substring(colon + 2)
        return when (code) {
            "secret-file" -> "This file may hold secrets, so it never leaves the computer."
            "no-folder" -> "This chat has no folder on the computer."
            "not-found" -> if (rest.isEmpty()) "Not found." else rest.replaceFirstChar { it.uppercase() } + "."
            else -> rest.replaceFirstChar { it.uppercase() } + "."
        }
    }
}

/** Validates computer paths without resolving them against the phone's file system. */
object WorkspacePath {
    fun isAbsolute(path: String): Boolean {
        if (path.isEmpty() || path.contains('\u0000') || path.contains('\n') || path.contains('\r')) return false
        if (path.startsWith("/")) return true
        if (path.length >= 3 && path[0].isLetter() && path[0].code < 128 && path[1] == ':' && (path[2] == '\\' || path[2] == '/')) return true
        // UNC paths need both a server and share, not a drive-relative path.
        return path.startsWith("\\\\") && path.drop(2).split('\\').size >= 2
    }
}
