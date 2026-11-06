package com.nekko.protocol

import java.net.URI

// Links in an assistant reply (AN-35, the iPhone's #1095), with the desktop's
// rules (`apps/desktop/src/renderer/chatArtifacts.ts`): a file the agent made
// on the computer opens in the phone's preview window, read through
// `artifact:read`; a dev server on the computer's loopback opens there too,
// through `preview:fetch`; other web links open in the browser. Nothing here
// touches the network: it only decides where a tap goes. Mirrors `ChatLinks.swift`.

/** Where a tapped link goes. */
sealed interface ChatLinkTarget {
    /** A file on the computer: absolute, `/`-separated (`/Users/a/x.html`, `C:/x/y.html`). */
    data class Artifact(val path: String) : ChatLinkTarget
    /** A page served on the computer's loopback (`http://localhost:5173/`). */
    data class Loopback(val url: String) : ChatLinkTarget
    /** An ordinary web or mail link, for the system to open. */
    data class Web(val url: String) : ChatLinkTarget
    data object Unsupported : ChatLinkTarget
}

/** What a preview shows, by the file's extension. */
enum class ArtifactKind {
    HTML, SVG, IMAGE, MARKDOWN, TEXT, PDF;

    /** Drawn by a web view (a live thumbnail, and the preview window). */
    val isWeb: Boolean get() = this == HTML || this == SVG

    companion object {
        fun ofExtension(ext: String): ArtifactKind? = when (ext.lowercase()) {
            "html", "htm" -> HTML
            "svg" -> SVG
            "png", "jpg", "jpeg", "gif", "webp" -> IMAGE
            "md", "markdown" -> MARKDOWN
            "txt", "json", "csv" -> TEXT
            "pdf" -> PDF
            else -> null
        }

        fun ofPath(path: String): ArtifactKind? {
            val name = path.substringAfterLast('/')
            val dot = name.lastIndexOf('.')
            if (dot <= 0) return null
            return ofExtension(name.substring(dot + 1))
        }
    }
}

/** One card under a reply: a file or a loopback page the agent linked. */
data class ChatPreviewLink(
    val target: Target,
    /** The link's label, or a name made from the file or folder. */
    val title: String,
    /** The file's name, or `host:port` for a loopback page. */
    val detail: String,
    /** A file's kind; null for a loopback page (always HTML from a server). */
    val kind: ArtifactKind?,
) {
    sealed interface Target {
        data class Artifact(val path: String) : Target
        data class Loopback(val url: String) : Target
    }

    /** Lower-case key the cards are deduplicated on. */
    val id: String = when (target) {
        is Target.Artifact -> "a:" + target.path.lowercase()
        is Target.Loopback -> "l:" + ChatLinks.loopbackKey(target.url)
    }

    /** The path or URL as the agent wrote it, for Copy. */
    val original: String get() = when (target) {
        is Target.Artifact -> target.path
        is Target.Loopback -> target.url
    }

    /** A live web thumbnail: HTML files and loopback pages. */
    val isWeb: Boolean get() = kind?.isWeb ?: true

    val isLoopback: Boolean get() = target is Target.Loopback
}

object ChatLinks {
    val PREVIEWABLE = setOf("html", "htm", "svg", "png", "jpg", "jpeg", "gif", "webp", "md", "markdown", "txt", "json", "csv", "pdf")
    private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0")

    /** Where [href] from an assistant reply goes. */
    fun classify(href: String): ChatLinkTarget {
        var s = href.trim()
        if (s.startsWith("<") && s.endsWith(">")) s = s.substring(1, s.length - 1)
        if (s.isEmpty()) return ChatLinkTarget.Unsupported
        val lower = s.lowercase()
        if (lower.startsWith("file:")) return artifactPathOfFileUrl(s)?.let(ChatLinkTarget::Artifact) ?: ChatLinkTarget.Unsupported
        if (lower.startsWith("http://") || lower.startsWith("https://")) {
            val uri = runCatching { URI(s) }.getOrNull() ?: return ChatLinkTarget.Unsupported
            val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return ChatLinkTarget.Unsupported
            if (host in LOOPBACK_HOSTS) {
                // The computer serves only a linked origin, and that needs a port.
                return if (uri.port < 0) ChatLinkTarget.Unsupported else ChatLinkTarget.Loopback(s)
            }
            return ChatLinkTarget.Web(s)
        }
        if (lower.startsWith("mailto:")) return ChatLinkTarget.Web(s)
        if (isAbsolutePath(s)) return artifactPath(s)?.let(ChatLinkTarget::Artifact) ?: ChatLinkTarget.Unsupported
        return ChatLinkTarget.Unsupported
    }

    /** `/…`, `C:/…` or `C:\…`; not `//host/…` (protocol-relative or UNC). */
    internal fun isAbsolutePath(s: String): Boolean {
        if (s.startsWith("/")) return !s.startsWith("//")
        return s.length >= 3 && s[0].isAsciiLetter() && s[1] == ':' && (s[2] == '/' || s[2] == '\\')
    }

    private fun Char.isAsciiLetter() = this in 'a'..'z' || this in 'A'..'Z'

    /** `file:///Users/a/x%20y.html` → `/Users/a/x y.html`; `file:///C:/x` → `C:/x`. */
    internal fun artifactPathOfFileUrl(s: String): String? {
        var rest = s.substring("file:".length)
        if (rest.startsWith("//")) {
            rest = rest.substring(2)
            // `file://localhost/x` and `file:///x`; any other host is another machine.
            val slash = rest.indexOf('/')
            if (slash < 0) return null
            val host = rest.substring(0, slash).lowercase()
            if (host.isNotEmpty() && host != "localhost") return null
            rest = rest.substring(slash)
        }
        // A malformed escape is refused, as the computer refuses it (phone-artifacts.json).
        var path = percentDecode(cutQueryAndFragment(rest)) ?: return null
        // `/C:/x` is a Windows drive.
        if (path.length >= 3 && path[0] == '/' && path[1].isLetter() && path[2] == ':') path = path.substring(1)
        return artifactPath(path, decoded = true)
    }

    /** An absolute path, normalized (`\` → `/`, `.` and `..` resolved), if it names a previewable file. */
    internal fun artifactPath(s: String, decoded: Boolean = false): String? {
        var p = cutQueryAndFragment(s)
        if (!decoded && '%' in p) p = percentDecode(p) ?: p
        p = p.replace('\\', '/')
        if (!isAbsolutePath(p)) return null
        // Control characters and Windows alternate data streams (`a.md:x`) are refused, as the computer refuses them.
        if (p.any { it < ' ' || it == '\u007f' } || ':' in p.replace(Regex("^[A-Za-z]:"), "")) return null
        val rooted = p.startsWith("/")
        val parts = mutableListOf<String>()
        for (part in p.split('/').filter { it.isNotEmpty() }) {
            when (part) {
                ".." -> if (parts.size > (if (rooted) 0 else 1)) parts.removeAt(parts.lastIndex)
                "." -> {}
                else -> parts += part
            }
        }
        val name = parts.lastOrNull() ?: return null
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || name.substring(dot + 1).lowercase() !in PREVIEWABLE) return null
        return (if (rooted) "/" else "") + parts.joinToString("/")
    }

    internal fun cutQueryAndFragment(s: String): String {
        val i = s.indexOfFirst { it == '#' || it == '?' }
        return if (i < 0) s else s.substring(0, i)
    }

    /** `%XX` sequences as UTF-8; null when one is malformed (the text is then kept as written). `+` stays `+`. */
    fun percentDecode(s: String): String? {
        if ('%' !in s) return s
        val out = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%') {
                if (i + 2 >= s.length) return null
                val hex = s.substring(i + 1, i + 3).toIntOrNull(16) ?: return null
                out.write(hex)
                i += 3
            } else {
                out.write(c.toString().toByteArray(Charsets.UTF_8))
                i++
            }
        }
        val bytes = out.toByteArray()
        val decoder = Charsets.UTF_8.newDecoder()
        return runCatching { decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString() }.getOrNull()
    }

    internal fun loopbackKey(url: String): String = url.substringBefore('#').lowercase()

    /** `localhost:5173`. */
    fun hostPort(url: String): String {
        val uri = runCatching { URI(url) }.getOrNull()
        val host = uri?.host ?: "localhost"
        val shown = if (':' in host && !host.startsWith("[")) "[$host]" else host
        return if (uri != null && uri.port >= 0) "$shown:${uri.port}" else shown
    }

    /**
     * Rewrites link destinations Markdown can't read as URLs (`C:\x\y.html`,
     * paths with spaces) into `file:` URLs, so they render as tappable links
     * and [classify] reads them back to the same path. Code is left alone.
     */
    fun linkable(s: String): String {
        if ("](" !in s) return s
        val out = StringBuilder()
        var i = 0
        var inCode = false
        while (i < s.length) {
            val c = s[i]
            if (c == '`') {
                inCode = !inCode
                out.append(c)
                i++
                continue
            }
            if (!inCode && c == ']' && s.startsWith("](", i)) {
                val close = s.indexOf(')', i)
                if (close >= 0) {
                    val dest = s.substring(i + 2, close)
                    val t = classify(dest)
                    if (t is ChatLinkTarget.Artifact && ('\\' in dest || ' ' in dest || dest.startsWith("<"))) {
                        out.append("](").append(fileUrl(t.path)).append(")")
                        i = close + 1
                        continue
                    }
                }
            }
            out.append(c)
            i++
        }
        return out.toString()
    }

    /** `C:/a b/x.html` → `file:///C:/a%20b/x.html`. */
    fun fileUrl(path: String): String = "file://" + encodePath(if (path.startsWith("/")) path else "/$path")

    /** Percent-encodes what a URL path can't hold as is (and `?`, `#`, `%`, `;`), as the iPhone does. */
    fun encodePath(path: String): String {
        val sb = StringBuilder()
        for (b in path.toByteArray(Charsets.UTF_8)) {
            val ch = (b.toInt() and 0xff)
            val c = ch.toChar()
            if (ch < 0x80 && (c.isLetterOrDigit() || c in "-._~!$&'()*+,=:@/")) sb.append(c)
            else sb.append('%').append("%02X".format(ch))
        }
        return sb.toString()
    }

    // `[label](href)`, `![alt](href)`, `<http://localhost:3000>` and bare loopback URLs, in reading order.
    private val LINKS = Regex(
        """!?\[([^\]\n]*)\]\(([^)\n]+)\)|<(https?://[^>\s]+)>|(https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s)<>\]"'`]*)""",
        RegexOption.IGNORE_CASE,
    )

    /** The files and loopback pages a reply links, once each, in order: the cards under it. Code is skipped, as on the desktop. */
    fun previews(text: String): List<ChatPreviewLink> {
        val out = mutableListOf<ChatPreviewLink>()
        val seen = mutableSetOf<String>()
        for (m in LINKS.findAll(stripCode(text))) {
            val g = m.groups
            val link = when {
                g[2] != null -> link(g[1]?.value.orEmpty(), destination(g[2]!!.value))
                else -> (g[3] ?: g[4])?.value?.let { link("", it.trim('.', ',', ';', ':', '!', '?')) }
            } ?: continue
            if (seen.add(link.id)) out += link
        }
        return out
    }

    /** The card a tapped link stands for: the reply's own card when it has one (it knows the link's label), else one made from the link alone. */
    fun preview(href: String, cards: List<ChatPreviewLink> = emptyList()): ChatPreviewLink? {
        val made = link("", href) ?: return null
        return cards.firstOrNull { it.id == made.id } ?: made
    }

    /** A Markdown link destination without its optional title (`x.html "Title"`). */
    internal fun destination(raw: String): String {
        val t = raw.trim()
        // `<…>` is kept whole: classify drops the brackets but not spaces inside them, as the computer does.
        if (t.startsWith("<")) {
            val end = t.indexOf('>')
            if (end > 0) return t.substring(0, end + 1)
        }
        val space = t.indexOf(' ')
        if (space >= 0) {
            val after = t.substring(space)
            if ('"' in after || '\'' in after) return t.substring(0, space)
        }
        return t
    }

    private val GENERIC = Regex("^(readme|index)(\\.[a-z]+)?$", RegexOption.IGNORE_CASE)
    private val INDEX = Regex("^(readme|index)\\.", RegexOption.IGNORE_CASE)

    internal fun link(label: String, href: String): ChatPreviewLink? {
        val l = label.trim()
        return when (val t = classify(href)) {
            is ChatLinkTarget.Artifact -> {
                val parts = t.path.split('/').filter { it.isNotEmpty() }
                val filename = parts.lastOrNull() ?: t.path
                val generic = l.isEmpty() || l == filename || l == href || l == t.path || GENERIC.matches(l)
                var title = l
                if (generic) {
                    val base = if (INDEX.containsMatchIn(filename)) (if (parts.size >= 2) parts[parts.size - 2] else "Document") else stem(filename)
                    title = humanize(base)
                }
                ChatPreviewLink(ChatPreviewLink.Target.Artifact(t.path), title.ifEmpty { filename }, filename, ArtifactKind.ofPath(t.path))
            }
            is ChatLinkTarget.Loopback -> {
                val hp = hostPort(t.url)
                val generic = l.isEmpty() || l == href || l == t.url
                ChatPreviewLink(ChatPreviewLink.Target.Loopback(t.url), if (generic) "Preview on $hp" else l, hp, null)
            }
            else -> null
        }
    }

    private fun stem(filename: String): String {
        val dot = filename.lastIndexOf('.')
        return if (dot <= 0) filename else filename.substring(0, dot)
    }

    /** `design-examples_v2` → `Design examples v2`. */
    internal fun humanize(s: String): String {
        val spaced = s.replace('-', ' ').replace('_', ' ')
        return spaced.take(1).uppercase() + spaced.drop(1)
    }

    /**
     * The text without fenced code blocks and inline code, exactly as the
     * computer strips them (`packages/shared/src/chat-links.ts`
     * `withoutFences`, `withoutInlineCode`), so the phone never offers a card
     * the computer would refuse: any ```` ``` ```` opens a fence, even mid-line,
     * and an unclosed one runs to the end.
     */
    internal fun stripCode(text: String): String {
        val fenced = StringBuilder()
        var i = 0
        while (true) {
            val open = text.indexOf("```", i)
            if (open < 0) {
                fenced.append(text, i, text.length)
                break
            }
            fenced.append(text, i, open)
            val close = text.indexOf("```", open + 3)
            if (close < 0) break
            i = close + 3
        }
        val t = fenced.toString()
        val out = StringBuilder()
        i = 0
        while (i < t.length) {
            if (t[i] == '`') {
                var j = i + 1
                while (j < t.length && t[j] != '`' && t[j] != '\n') j++
                if (j < t.length && t[j] == '`') {
                    i = j + 1
                    continue
                }
            }
            out.append(t[i])
            i++
        }
        return out.toString()
    }
}
