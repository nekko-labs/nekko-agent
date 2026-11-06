package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.regex.Pattern

// The computer's logs, read only, from the phone (AN-34, the iPhone's IO-33
// FA-5): the desktop app's log, the engine's, and each chat's agent run log,
// as the computer projects them (packages/shared/src/phone-files.ts), and
// what Share sends. Mirrors the log half of `Files.swift` and `LogShare.swift`.

/** One of the computer's logs. */
data class LogInfo(
    /** `app`, `daemon`, or `agent:<chatId>`. */
    val id: String,
    val title: String,
    val kind: Kind,
    val size: Long,
    /** Epoch ms of the last write; null when empty. */
    val updatedAt: Long? = null,
    val sessionId: String? = null,
) {
    enum class Kind(val wire: String) { APP("app"), DAEMON("daemon"), AGENT("agent") }

    companion object {
        fun list(v: JsonElement?): List<LogInfo> = v.arr().orEmpty().mapNotNull { e ->
            val l = e.obj() ?: return@mapNotNull null
            val id = l.str("id") ?: return@mapNotNull null
            LogInfo(
                id, l.str("title") ?: id, Kind.entries.firstOrNull { it.wire == l.str("kind") } ?: Kind.APP,
                l.long("size") ?: 0, l.dbl("updatedAt")?.toLong(), l.str("sessionId"),
            )
        }
    }
}

/** A log's tail, or the lines that matched a search. */
data class LogText(
    val id: String,
    val size: Long = 0,
    /** Older lines exist before what was sent. */
    val truncated: Boolean = false,
    val text: String? = null,
    val query: String? = null,
    val matches: List<Match> = emptyList(),
    val moreMatches: Boolean = false,
) {
    data class Match(val line: Int, val text: String)

    /** The tail's lines, without the empty one after a final newline. */
    val lines: List<String>
        get() {
            val all = (text ?: return emptyList()).split("\n")
            return if (all.last().isEmpty()) all.dropLast(1) else all
        }

    companion object {
        fun from(v: JsonElement?): LogText? {
            val o = v.obj() ?: return null
            val id = o.str("id") ?: return null
            val matches = o["matches"].arr().orEmpty().mapNotNull { m ->
                val mo = m.obj() ?: return@mapNotNull null
                mo.long("line")?.let { Match(it.toInt(), mo.str("text").orEmpty()) }
            }
            return LogText(id, o.long("size") ?: 0, o.bool("truncated"), o.str("text"), o.str("query"), matches, o.bool("moreMatches"))
        }
    }
}

/**
 * What *Share* on a log sends: the lines on screen as plain text, redacted
 * again on the phone. The computer already redacts every line it sends
 * (`crates/nekkod/src/logs.rs` `redact`); this is the same rule set, so a log
 * from an older computer, or a secret shape the computer's copy learns later,
 * still doesn't leave the phone. Both are held to
 * `crates/nekkod/tests/golden/log-redact.json`.
 */
object LogShare {
    const val REDACTED = "[redacted]"

    /**
     * Unicode `\s` and `\b`, as the computer's Rust regex and the iPhone's ICU
     * have them. Android's regex is ICU and already works so (it refuses the
     * flag); the JVM the tests run on needs `UNICODE_CHARACTER_CLASS`.
     */
    private fun re(pattern: String, caseless: Boolean = false): Regex {
        val flags = if (caseless) Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE else 0
        val p = try {
            Pattern.compile(pattern, flags or Pattern.UNICODE_CHARACTER_CLASS)
        } catch (_: IllegalArgumentException) {
            Pattern.compile(pattern, flags)
        }
        return p.toRegex()
    }

    private val userinfo = re("""([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@""", true)
    private val scheme = re("""\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})""", true)
    private val query = re(
        """([?&](?:room|key|pair|code|token|access_token|refresh_token|id_token|sig|signature|auth|password|secret|apikey|api_key)=)[^&\s#]+""",
        true,
    )
    private val pairs = re(
        """(?<![A-Za-z0-9])((?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|passphrase|private[_-]?key|authorization|cookie|set-cookie|session[_-]?id|x-api-key|key)["']?\s*[:=]\s*["']?)([^\s"',;&}]+)""",
        true,
    )
    private val tokens = re(
        """(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})""",
    )
    private val privateKey = re("""-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----""", true)
    private val hex = re("""(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])""")
    private val run = re("""[A-Za-z0-9+/_-]{40,}={0,2}""")

    private fun Char.isAsciiUpper() = this in 'A'..'Z'
    private fun Char.isAsciiLower() = this in 'a'..'z'
    private fun Char.isAsciiDigit() = this in '0'..'9'

    /** A long base64-ish run that looks like a key rather than a path or a word. */
    internal fun looksLikeKey(run: String): Boolean {
        if (!run.any { it.isAsciiUpper() } || !run.any { it.isAsciiLower() } || !run.any { it.isAsciiDigit() }) return false
        return '/' !in run || run.split('/').all { it.length >= 24 || it.isEmpty() }
    }

    /** One line with anything that looks like a secret replaced, exactly as the computer does. */
    fun redact(line: String): String {
        if (privateKey.containsMatchIn(line)) return "$REDACTED private key"
        var s = userinfo.replace(line) { it.groupValues[1] + "$REDACTED@" }
        s = scheme.replace(s) { it.groupValues[1] + " " + REDACTED }
        s = query.replace(s) { it.groupValues[1] + REDACTED }
        s = pairs.replace(s) { m ->
            val value = m.groupValues[2]
            if (value.startsWith(REDACTED) || value.equals("bearer", ignoreCase = true) || value.equals("basic", ignoreCase = true)) m.groupValues[1] + value
            else m.groupValues[1] + REDACTED
        }
        s = tokens.replace(s, REDACTED)
        s = hex.replace(s, REDACTED)
        return run.replace(s) { if (looksLikeKey(it.value)) REDACTED else it.value }
    }

    /** The text *Share* sends for what the log screen shows: its tail, or the lines matching a search with their numbers. */
    fun text(title: String, log: LogText, atMs: Long = System.currentTimeMillis()): String {
        val lines = mutableListOf(
            "Nekko Agent log: ${redact(title)}",
            "Shared: ${Instant.ofEpochMilli(atMs).truncatedTo(ChronoUnit.SECONDS)}",
            "Secrets were removed on the computer and again on this phone. Check before you send it on.",
            "",
        )
        val q = log.query
        if (!q.isNullOrEmpty()) {
            lines += "Lines matching \"${redact(q)}\":"
            lines += log.matches.map { "${it.line}: ${redact(it.text)}" }
            if (log.moreMatches) lines += "(more lines match)"
        } else {
            if (log.truncated) lines += "(older lines are on the computer)"
            lines += log.lines.map(::redact)
        }
        return lines.joinToString("\n")
    }
}
