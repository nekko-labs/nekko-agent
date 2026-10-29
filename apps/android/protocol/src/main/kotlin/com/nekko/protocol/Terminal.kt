package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Terminals and SSH on the phone (AN-31, the iPhone's IO-33 FA-3 / FA-6), as
// the computer projects them for phones (packages/shared/src/phone-terminal.ts):
// one chat's terminals without paths, a capped tail, SSH hosts without user
// names, and the live `terminal:event` output of the terminals this phone
// opened. Mirrors `Terminal.swift`.
//
// Opening a terminal (`terminal:open`, `terminal:create`, `ssh:open`) is a
// Change action (one fingerprint or screen lock within 5 minutes) and answers
// a token; typing (`terminal:write`) and resizing carry that token instead of
// a proof each.

object TerminalChannels {
    const val LIST = "terminals:list"
    const val TAIL = "terminal:tail"
    const val CREATE = "terminal:create"
    const val WRITE = "terminal:write"
    const val RESIZE = "terminal:resize"
    const val SIGNAL = "terminal:signal"
    const val CLOSE = "terminal:close"
    /** Answered by the computer's gate: attach to a terminal (Change, signed). */
    const val OPEN = "terminal:open"
    /** Answered by the computer's gate: stop watching a terminal (no proof). */
    const val LEAVE = "terminal:leave"
    const val SSH_HOSTS = "ssh:hosts"
    const val SSH_OPEN = "ssh:open"
    /** The output of the terminals this phone opened (and only those). */
    const val EVENT = "terminal:event"

    /** The terminal channels the computer asks a signed proof for (`terminal:open` is the gate's own). */
    val CHANGE = setOf(CREATE, SSH_OPEN, SIGNAL, CLOSE)

    /** The ones in the computer's channel list (`terminal:open` / `terminal:leave` are the gate's). */
    val ALL = listOf(LIST, TAIL, CREATE, WRITE, RESIZE, SIGNAL, CLOSE, SSH_HOSTS, SSH_OPEN)
}

/** The computer's limits for terminals on a phone (`PHONE_TERMINAL`). */
object TerminalLimits {
    const val WRITE_BYTES = 64 * 1024
    const val MAX_COLS = 500
    const val MAX_ROWS = 300
}

/** A terminal as the phone sees it: the folder's name, never its path. */
data class PhoneTerminal(
    val id: String,
    val title: String,
    val kind: Kind = Kind.SHELL,
    val folder: String = "",
    val shell: String = "",
    val running: Boolean = true,
    val exitCode: Int? = null,
    val createdAt: Long? = null,
    val sessionId: String? = null,
    /** Phones attached right now. */
    val viewers: Int = 0,
) {
    enum class Kind(val wire: String) { SHELL("shell"), SSH("ssh"), AGENT("agent") }

    /** The agent's command log: read only on the phone. */
    val readOnly: Boolean get() = kind == Kind.AGENT

    /** What the list shows under the title. */
    val detail: String
        get() {
            val parts = mutableListOf<String>()
            when (kind) {
                Kind.AGENT -> parts += "Agent commands"
                Kind.SSH -> parts += "SSH"
                Kind.SHELL -> if (shell.isNotEmpty()) parts += shell
            }
            if (folder.isNotEmpty() && kind != Kind.AGENT) parts += folder
            if (!running) parts += exitCode?.let { "exited ($it)" } ?: "exited"
            return parts.joinToString(" · ")
        }

    companion object {
        fun from(v: JsonElement?): PhoneTerminal? {
            val o = v.obj() ?: return null
            val id = o.str("id") ?: return null
            return PhoneTerminal(
                id = id, title = o.str("title").orEmpty(), kind = Kind.entries.firstOrNull { it.wire == o.str("kind") } ?: Kind.SHELL,
                folder = o.str("folder").orEmpty(), shell = o.str("shell").orEmpty(), running = o.bool("running"),
                exitCode = o.long("exitCode")?.toInt(), createdAt = o.long("createdAt"), sessionId = o.str("sessionId"),
                viewers = o.long("viewers")?.toInt() ?: 0,
            )
        }

        fun list(v: JsonElement?): List<PhoneTerminal> = v.arr().orEmpty().mapNotNull(::from)
    }
}

/** A host from the computer's `~/.ssh/config`: alias and where it goes, no user. */
data class SshHost(val alias: String, val hostName: String? = null, val port: Int? = null) {
    /** `devbox.lan:2222`, or nothing when the alias says it all. */
    val detail: String?
        get() = if (hostName.isNullOrEmpty()) port?.let { "port $it" } else port?.let { "$hostName:$it" } ?: hostName

    companion object {
        fun list(v: JsonElement?): List<SshHost> = v.arr().orEmpty().mapNotNull { e ->
            val h = e.obj() ?: return@mapNotNull null
            val alias = h.str("alias")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            SshHost(alias, h.str("hostName"), h.long("port")?.toInt())
        }
    }
}

/** `terminal:tail`: the newest scroll-back (at most 64 KB), cut cleanly by the computer. */
data class TerminalTail(val terminal: PhoneTerminal?, val buffer: String, val cols: Int, val rows: Int, val truncated: Boolean = false) {
    companion object {
        fun from(v: JsonElement?): TerminalTail? {
            val o = v.obj() ?: return null
            return TerminalTail(
                PhoneTerminal.from(o["terminal"]), o.str("buffer").orEmpty(), o.long("cols")?.toInt() ?: 80, o.long("rows")?.toInt() ?: 24, o.bool("truncated"),
            )
        }
    }
}

/** What opening a terminal answers: its tail and the token for typing into it. */
data class TerminalOpened(val tail: TerminalTail, val token: String, val idleMs: Long = 300_000, val maxMs: Long = 1_800_000) {
    companion object {
        fun from(v: JsonElement?): TerminalOpened? {
            val tail = TerminalTail.from(v) ?: return null
            val o = v.obj() ?: return null
            val token = o.str("token")?.takeIf { it.isNotEmpty() } ?: return null
            return TerminalOpened(tail, token, o.long("idleMs") ?: 300_000, o.long("maxMs") ?: 1_800_000)
        }
    }
}

/** One `terminal:event`. */
sealed interface TerminalEvent {
    val terminalId: String

    /** Output. [skipped] > 0: the computer dropped that much (a flood); read the tail again. */
    data class Data(override val terminalId: String, val text: String, val skipped: Int = 0) : TerminalEvent
    data class Exit(override val terminalId: String, val code: Int?) : TerminalEvent

    companion object {
        fun from(payload: JsonElement?): TerminalEvent? {
            val o = payload.obj() ?: return null
            val id = o.str("terminalId") ?: return null
            return when (o.str("type")) {
                "data" -> Data(id, o.str("data").orEmpty(), o.long("skipped")?.toInt() ?: 0)
                "exit" -> Exit(id, o.long("code")?.toInt())
                else -> null
            }
        }
    }
}

/** One call a terminal screen makes: the channel and its arguments. */
data class TerminalRequest(val channel: String, val args: List<JsonElement>) {
    companion object {
        private fun size(cols: Int, rows: Int) =
            cols.coerceIn(1, TerminalLimits.MAX_COLS) to rows.coerceIn(1, TerminalLimits.MAX_ROWS)

        private fun place(sessionId: String, cols: Int, rows: Int): JsonObject {
            val (c, r) = size(cols, rows)
            return buildJsonObject { put("sessionId", sessionId); put("cols", c); put("rows", r) }
        }

        /** One chat's terminals (the computer refuses a list without a chat). */
        fun list(sessionId: String) = TerminalRequest(TerminalChannels.LIST, listOf(buildJsonObject { put("sessionId", sessionId) }))
        fun tail(id: String) = TerminalRequest(TerminalChannels.TAIL, listOf(JsonPrimitive(id)))
        fun open(id: String) = TerminalRequest(TerminalChannels.OPEN, listOf(JsonPrimitive(id)))
        fun leave(id: String) = TerminalRequest(TerminalChannels.LEAVE, listOf(JsonPrimitive(id)))

        /** A new terminal in the chat's folder (the computer picks the folder and the shell). */
        fun create(sessionId: String, cols: Int, rows: Int) = TerminalRequest(TerminalChannels.CREATE, listOf(place(sessionId, cols, rows)))

        fun sshOpen(alias: String, sessionId: String, cols: Int, rows: Int) =
            TerminalRequest(TerminalChannels.SSH_OPEN, listOf(JsonPrimitive(alias), place(sessionId, cols, rows)))

        fun write(id: String, data: String, token: String) =
            TerminalRequest(TerminalChannels.WRITE, listOf(JsonPrimitive(id), JsonPrimitive(data), JsonPrimitive(token)))

        fun resize(id: String, cols: Int, rows: Int, token: String): TerminalRequest {
            val (c, r) = size(cols, rows)
            return TerminalRequest(TerminalChannels.RESIZE, listOf(JsonPrimitive(id), JsonPrimitive(c), JsonPrimitive(r), JsonPrimitive(token)))
        }

        fun signal(id: String) = TerminalRequest(TerminalChannels.SIGNAL, listOf(JsonPrimitive(id)))
        fun close(id: String) = TerminalRequest(TerminalChannels.CLOSE, listOf(JsonPrimitive(id)))
        fun hosts() = TerminalRequest(TerminalChannels.SSH_HOSTS, emptyList())
    }
}

/** Keys of the key row. */
sealed interface TerminalKey {
    data object Escape : TerminalKey
    data object Tab : TerminalKey
    data object Enter : TerminalKey
    data object Backspace : TerminalKey
    data object Up : TerminalKey
    data object Down : TerminalKey
    data object Left : TerminalKey
    data object Right : TerminalKey
    data object Home : TerminalKey
    data object End : TerminalKey
    data object PageUp : TerminalKey
    data object PageDown : TerminalKey
    /** Ctrl and a key: `c` is Ctrl-C (ETX). */
    data class Ctrl(val c: Char) : TerminalKey
}

object TerminalKeys {
    /** The bytes for [key]. [appCursor]: the program asked for application cursor keys (DECCKM). */
    fun bytes(key: TerminalKey, appCursor: Boolean = false): String? {
        val csi = if (appCursor) "\u001bO" else "\u001b["
        return when (key) {
            TerminalKey.Escape -> "\u001b"
            TerminalKey.Tab -> "\t"
            TerminalKey.Enter -> "\r"
            TerminalKey.Backspace -> "\u007f"
            TerminalKey.Up -> csi + "A"
            TerminalKey.Down -> csi + "B"
            TerminalKey.Right -> csi + "C"
            TerminalKey.Left -> csi + "D"
            TerminalKey.Home -> csi + "H"
            TerminalKey.End -> csi + "F"
            TerminalKey.PageUp -> "\u001b[5~"
            TerminalKey.PageDown -> "\u001b[6~"
            is TerminalKey.Ctrl -> control(key.c)
        }
    }

    /** Ctrl plus a character: letters and `@[\]^_` map to C0, `?` to DEL, space to NUL. */
    fun control(c: Char): String? = when (val a = c.lowercaseChar().code) {
        in 0x61..0x7a -> (a - 0x60).toChar().toString()
        0x40, 0x20 -> "\u0000"
        0x5b -> "\u001b"
        0x5c -> "\u001c"
        0x5d -> "\u001d"
        0x5e -> "\u001e"
        0x5f -> "\u001f"
        0x3f -> "\u007f"
        else -> null
    }

    /**
     * Pasted text: line ends become Return, wrapped in bracketed-paste markers
     * when the program asked for them (so a shell doesn't run each line); a
     * pasted end marker is removed so text can't escape the paste.
     */
    fun paste(text: String, bracketed: Boolean): String {
        val body = text.replace("\u001b[201~", "").replace("\r\n", "\r").replace("\n", "\r")
        return if (bracketed) "\u001b[200~$body\u001b[201~" else body
    }

    /** A typed or dictated command line, sent with Return. */
    fun line(text: String): String = text.replace("\r\n", " ").replace("\n", " ") + "\r"

    /** [text] in parts of at most [maxBytes] UTF-8 bytes, never splitting a character. */
    fun chunks(text: String, maxBytes: Int = TerminalLimits.WRITE_BYTES): List<String> {
        if (text.toByteArray(Charsets.UTF_8).size <= maxBytes) return if (text.isEmpty()) emptyList() else listOf(text)
        val out = mutableListOf<String>()
        val part = StringBuilder()
        var size = 0
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            val ch = String(Character.toChars(cp))
            val n = ch.toByteArray(Charsets.UTF_8).size
            if (size + n > maxBytes && part.isNotEmpty()) {
                out += part.toString()
                part.clear()
                size = 0
            }
            part.append(ch)
            size += n
            i += Character.charCount(cp)
        }
        if (part.isNotEmpty()) out += part.toString()
        return out
    }
}

/**
 * A refusal of a terminal call that opening the terminal again fixes: the
 * token ended (idle, too old) or the computer forgot it (a restart, a reconnect).
 */
object TerminalRefusal {
    val REOPEN_CODES = setOf("token-expired", "token-invalid", "token-required")

    fun code(e: Throwable): String? = (e as? RelayException)?.let { it.refusal?.code ?: PhoneRefusal.parse(it.message)?.code }

    fun needsReopen(e: Throwable): Boolean = code(e) in REOPEN_CODES

    /** What to tell the owner for a terminal refusal, or null for the computer's message. */
    fun message(code: String, computer: String): String? = when (code) {
        "terminal-hidden" -> "$computer doesn’t share that terminal with phones. Only a chat’s terminals open here."
        "token-expired", "token-invalid", "token-required" -> "This terminal needs your fingerprint or screen lock again. Open it again to keep typing."
        else -> null
    }
}
