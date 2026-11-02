package com.nekko.protocol

/**
 * *Paste as Markdown* (MD-6, the iPhone's MD-4 `RichPaste`): rich clipboard
 * HTML (a browser, Mail, Google Docs) turned into the Markdown the composer
 * keeps as source.
 *
 * A small tolerant HTML reader in pure Kotlin: the HTML is never loaded into a
 * web view or `Html.fromHtml`, so nothing in it runs or is fetched. Scripts,
 * styles, frames, objects, images and SVG are dropped with their content; only
 * `http(s):` and `mailto:` links are kept. Mirrors the desktop's
 * `clipboardMarkdown` and adds nested lists and simple tables.
 */
object RichPaste {
    /** Clipboard HTML bigger than this pastes as its plain text instead. */
    const val MAX_HTML = 2_000_000

    /** The Markdown for [html], or [plain] (newlines normalised) when there is no HTML or it holds no text. */
    fun markdown(html: String?, plain: String): String {
        val fallback = plain.replace("\r\n", "\n").replace("\r", "\n")
        if (html.isNullOrEmpty() || html.toByteArray(Charsets.UTF_8).size > MAX_HTML) return fallback
        val root = HtmlReader(html).parse()
        val body = root.find("body") ?: root
        val tidy = tidyUp(Writer.blocks(body.children, ""))
        return tidy.ifEmpty { fallback }
    }

    /** At most one blank line in a row, no trailing spaces, trimmed. */
    internal fun tidyUp(s: String): String {
        val out = mutableListOf<String>()
        for (raw in s.split("\n")) {
            val l = raw.trimEnd(' ', '\t')
            if (!(l.isEmpty() && (out.lastOrNull()?.isEmpty() ?: true))) out += l
        }
        while (out.lastOrNull()?.isEmpty() == true) out.removeAt(out.lastIndex)
        return out.joinToString("\n")
    }

    /** Spaces and tabs, and the other Unicode space separators (Swift's `.whitespaces`). */
    private fun Char.isSpace() = this == ' ' || this == '\t' || Character.getType(this) == Character.SPACE_SEPARATOR.toInt()
    private fun String.trimSpaces() = trim { it.isSpace() }
    private val WHITESPACE = Regex("""[\s\p{Zs}]+""")
    private val RUNS = Regex("""[ \t]{2,}""")

    internal object Writer {
        /** Elements dropped with everything inside them. */
        val DROPPED = setOf(
            "script", "style", "iframe", "object", "embed", "img", "svg", "math", "noscript", "template", "head", "title", "meta", "link",
            "canvas", "video", "audio", "picture", "source", "form", "input", "button", "select", "textarea",
        )
        val BLOCK_TAGS = setOf(
            "p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "ul", "ol", "li", "blockquote", "pre", "table",
            "h1", "h2", "h3", "h4", "h5", "h6", "hr", "dl", "dt", "dd", "figure", "figcaption", "address", "details", "summary",
        )

        /** Block-level content: paragraphs separated by a blank line, each line under [indent]. */
        fun blocks(nodes: List<HtmlNode>, indent: String): String {
            val parts = mutableListOf<String>()
            val inline = mutableListOf<HtmlNode>()
            fun flushInline() {
                val text = inlineText(inline).split("\n").joinToString("\n") { it.trimSpaces() }
                if (text.isNotBlank()) parts += text
                inline.clear()
            }
            for (n in nodes) {
                if (n is HtmlNode.Element) {
                    val e = n.element
                    if (e.tag in DROPPED) continue
                    val b = when {
                        e.tag in BLOCK_TAGS -> block(e, indent)
                        // An inline wrapper around blocks (Google Docs puts everything in one <b>): see through it.
                        holdsBlocks(e) -> blocks(e.children, indent)
                        else -> {
                            inline += n
                            continue
                        }
                    }
                    flushInline()
                    if (b.isNotBlank()) parts += b
                } else {
                    inline += n
                }
            }
            flushInline()
            return parts.joinToString("\n\n")
        }

        fun block(e: HtmlElement, indent: String): String = when (e.tag) {
            "h1", "h2", "h3", "h4", "h5", "h6" -> "#".repeat(e.tag.drop(1).toIntOrNull() ?: 1) + " " + oneLine(inlineText(e.children))
            "hr" -> "---"
            "pre" -> {
                val code = e.textContent.replace("\r\n", "\n")
                val lang = e.find("code")?.attributes?.get("class")?.split(' ')?.firstOrNull { it.startsWith("language-") }?.drop(9).orEmpty()
                val body = if (code.endsWith("\n")) code.dropLast(1) else code
                val fence = if ("```" in body) "~~~" else "```"
                fence + lang + "\n" + body + "\n" + fence
            }
            "blockquote" -> blocks(e.children, "").split("\n").joinToString("\n") { if (it.isEmpty()) ">" else "> $it" }
            "ul", "ol" -> list(e, indent)
            // A stray item outside a list.
            "li" -> "- " + blocks(e.children, "$indent  ")
            "table" -> table(e)
            else -> blocks(e.children, indent)
        }

        /** A list, nested lists indented under their item's text. */
        fun list(e: HtmlElement, indent: String): String {
            val ordered = e.tag == "ol"
            var n = e.attributes["start"]?.toIntOrNull() ?: 1
            val lines = mutableListOf<String>()
            for (child in e.children) {
                val li = (child as? HtmlNode.Element)?.element ?: continue
                if (li.tag == "ul" || li.tag == "ol") {
                    // A list directly inside a list (as some editors write it) nests under the previous item.
                    lines += list(li, indent + if (ordered) "   " else "  ")
                    continue
                }
                if (li.tag != "li") continue
                val marker = if (ordered) "$n. " else "- "
                n++
                val hang = indent + " ".repeat(marker.length)
                val textNodes = mutableListOf<HtmlNode>()
                val nested = mutableListOf<String>()
                for (c in li.children) {
                    val sub = (c as? HtmlNode.Element)?.element
                    if (sub != null && (sub.tag == "ul" || sub.tag == "ol")) nested += list(sub, hang) else textNodes += c
                }
                var task = ""
                val box = li.find("input")
                if (box != null && box.attributes["type"]?.lowercase() == "checkbox") task = if ("checked" in box.attributes) "[x] " else "[ ] "
                val body = blocks(textNodes, hang).split("\n").filter { it.isNotBlank() }
                val itemLines = mutableListOf(indent + marker + task + body.firstOrNull().orEmpty())
                itemLines += body.drop(1).map { hang + it }
                lines += itemLines.joinToString("\n")
                lines += nested
            }
            return lines.joinToString("\n")
        }

        /** Rows of `th`/`td` cells as a pipe table, the first row as its header. */
        fun table(e: HtmlElement): String {
            val rows = mutableListOf<List<String>>()
            fun collect(el: HtmlElement) {
                for (c in el.children) {
                    val x = (c as? HtmlNode.Element)?.element ?: continue
                    if (x.tag == "tr") {
                        val cells = x.children.mapNotNull { node ->
                            val cell = (node as? HtmlNode.Element)?.element ?: return@mapNotNull null
                            if (cell.tag != "td" && cell.tag != "th") return@mapNotNull null
                            oneLine(inlineText(cell.children)).replace("|", "\\|")
                        }
                        if (cells.isNotEmpty()) rows += cells
                    } else if (x.tag in setOf("thead", "tbody", "tfoot")) {
                        collect(x)
                    }
                }
            }
            collect(e)
            val header = rows.firstOrNull() ?: return ""
            val width = rows.maxOf { it.size }
            fun row(r: List<String>) = "| " + (r + List(width - r.size) { "" }).joinToString(" | ") + " |"
            val divider = "| " + List(width) { "---" }.joinToString(" | ") + " |"
            return (listOf(row(header), divider) + rows.drop(1).map(::row)).joinToString("\n")
        }

        // ---- inline ----

        fun inlineText(nodes: List<HtmlNode>): String {
            val out = nodes.joinToString("") { inline(it) }
            // Collapsed HTML whitespace, but the line breaks a <br> made stay.
            return out.split("\n").joinToString("\n") { RUNS.replace(it, " ") }
        }

        fun inline(n: HtmlNode): String = when (n) {
            is HtmlNode.Text -> escape(WHITESPACE.replace(n.text, " "))
            is HtmlNode.Element -> {
                val e = n.element
                if (e.tag in DROPPED) {
                    ""
                } else {
                    val inner = inlineText(e.children)
                    val style = e.attributes["style"].orEmpty().lowercase().replace(" ", "")
                    when (e.tag) {
                        "br" -> "\n"
                        // Google Docs wraps everything in <b style="font-weight:normal">.
                        "strong", "b" -> if ("font-weight:normal" in style || "font-weight:400" in style) inner else wrap(inner, "**")
                        "em", "i", "cite" -> wrap(inner, "*")
                        "s", "del", "strike" -> wrap(inner, "~~")
                        "code", "kbd", "samp", "tt" -> e.textContent.let { if ('`' in it) "`` $it ``" else "`$it`" }
                        "a" -> {
                            val href = e.attributes["href"].orEmpty().trim()
                            if (!safeLink(href)) {
                                inner
                            } else {
                                val url = href.replace("(", "%28").replace(")", "%29").replace(" ", "%20")
                                val label = inner.trimSpaces()
                                "[" + label.ifEmpty { escape(href) } + "](" + url + ")"
                            }
                        }
                        "span", "font" -> {
                            var out = inner
                            if ("font-weight:bold" in style || "font-weight:700" in style || "font-weight:600" in style) out = wrap(out, "**")
                            if ("font-style:italic" in style) out = wrap(out, "*")
                            if ("line-through" in style) out = wrap(out, "~~")
                            out
                        }
                        else -> if (e.tag in BLOCK_TAGS) "\n$inner\n" else inner
                    }
                }
            }
        }

        /** Marks around the text, with its outer spaces kept outside them (`** bold**` isn't bold). */
        fun wrap(s: String, mark: String): String {
            val core = s.trimSpaces()
            if (core.isEmpty()) return s
            val lead = s.takeWhile { it == ' ' }
            val trail = s.takeLastWhile { it == ' ' }
            return lead + mark + core + mark + trail
        }

        fun oneLine(s: String) = s.replace("\n", " ").trimSpaces()

        /** Markdown's own characters in text are escaped, so pasted prose stays prose. */
        fun escape(s: String): String {
            val out = StringBuilder()
            for (ch in s) {
                if (ch in "\\`*_[]~") out.append('\\')
                out.append(ch)
            }
            return out.toString()
        }

        fun holdsBlocks(e: HtmlElement): Boolean = e.children.any { n ->
            val c = (n as? HtmlNode.Element)?.element ?: return@any false
            c.tag !in DROPPED && (c.tag in BLOCK_TAGS || holdsBlocks(c))
        }

        fun safeLink(href: String): Boolean = href.lowercase().let { it.startsWith("http://") || it.startsWith("https://") || it.startsWith("mailto:") }
    }
}

// ---- a tolerant HTML reader ----

internal sealed interface HtmlNode {
    class Text(val text: String) : HtmlNode
    class Element(val element: HtmlElement) : HtmlNode
}

internal class HtmlElement(val tag: String, val attributes: MutableMap<String, String> = mutableMapOf()) {
    val children = mutableListOf<HtmlNode>()

    val textContent: String
        get() = children.joinToString("") { n ->
            when (n) {
                is HtmlNode.Text -> n.text
                is HtmlNode.Element -> when {
                    n.element.tag in RichPaste.Writer.DROPPED -> ""
                    n.element.tag == "br" -> "\n"
                    else -> n.element.textContent
                }
            }
        }

    /** The first descendant (or self) with this tag. */
    fun find(tag: String): HtmlElement? {
        if (this.tag == tag) return this
        for (c in children) if (c is HtmlNode.Element) c.element.find(tag)?.let { return it }
        return null
    }
}

/**
 * Reads HTML into a tree the way browsers roughly do: unknown or mismatched
 * closing tags are tolerated, `<p>` and `<li>` close themselves, void elements
 * have no content, and `<script>`/`<style>` bodies are skipped unread.
 * Comments, doctypes and processing instructions are ignored.
 */
internal class HtmlReader(private val s: String) {
    companion object {
        val VOID = setOf("br", "hr", "img", "meta", "link", "input", "area", "base", "col", "embed", "source", "track", "wbr", "param")
        val RAW_TEXT = setOf("script", "style", "textarea", "title", "xmp", "noscript", "template", "iframe")
        val ENTITIES = mapOf(
            "amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ", "mdash" to "—", "ndash" to "–",
            "hellip" to "…", "rsquo" to "’", "lsquo" to "‘", "rdquo" to "”", "ldquo" to "“", "bull" to "•", "copy" to "©", "reg" to "®",
            "trade" to "™", "middot" to "·", "times" to "×", "rarr" to "→", "larr" to "←", "deg" to "°", "euro" to "€",
        )

        /** `&amp;`, `&#39;`, `&#x1F600;` and the common named entities. */
        fun decode(s: String): String {
            if ('&' !in s) return s
            val out = StringBuilder()
            var i = 0
            while (i < s.length) {
                if (s[i] == '&') {
                    val semi = s.indexOf(';', i).takeIf { it in (i + 1)..(i + 12) }
                    if (semi != null) {
                        val name = s.substring(i + 1, semi)
                        val code = when {
                            name.startsWith("#x") || name.startsWith("#X") -> name.drop(2).toIntOrNull(16)
                            name.startsWith("#") -> name.drop(1).toIntOrNull()
                            else -> null
                        }
                        val replacement = when {
                            code != null -> code.takeIf { Character.isValidCodePoint(it) && it !in 0xD800..0xDFFF }?.let { String(Character.toChars(it)) }
                            else -> ENTITIES[name]
                        }
                        if (replacement != null) {
                            out.append(replacement)
                            i = semi + 1
                            continue
                        }
                    }
                }
                out.append(s[i])
                i++
            }
            return out.toString()
        }
    }

    fun parse(): HtmlElement {
        val root = HtmlElement("#root")
        val stack = mutableListOf(root)
        var i = 0
        val text = StringBuilder()
        fun flushText() {
            if (text.isNotEmpty()) stack.last().children += HtmlNode.Text(decode(text.toString()))
            text.clear()
        }
        fun close(tag: String) {
            val k = stack.indexOfLast { it.tag == tag }
            if (k > 0) while (stack.size > k) stack.removeAt(stack.lastIndex)
        }
        while (i < s.length) {
            val c = s[i]
            if (c != '<' || i + 1 >= s.length) {
                text.append(c)
                i++
                continue
            }
            val next = s[i + 1]
            if (next == '!' || next == '?') {
                flushText()
                i = if (s.startsWith("<!--", i)) s.indexOf("-->", i + 4).let { if (it < 0) s.length else it + 3 }
                else s.indexOf('>', i).let { if (it < 0) s.length else it + 1 }
                continue
            }
            if (next == '/') {
                flushText()
                val end = s.indexOf('>', i).let { if (it < 0) s.length else it }
                close(s.substring(i + 2, end).trim().lowercase())
                i = minOf(s.length, end + 1)
                continue
            }
            if (!next.isLetter()) {
                text.append(c)
                i++
                continue
            }
            flushText()
            val (tag, attrs, selfClosing, end) = readTag(i + 1)
            i = end
            // Implicitly closed: a new <p> or block closes an open <p>; a new <li> closes the open <li>; same for rows and cells.
            if (tag == "li") closeOpen("li", setOf("ul", "ol"), stack)
            if (tag == "tr") closeOpen("tr", setOf("table", "thead", "tbody", "tfoot"), stack)
            if (tag == "td" || tag == "th") {
                closeOpen("td", setOf("tr"), stack)
                closeOpen("th", setOf("tr"), stack)
            }
            if (tag in RichPaste.Writer.BLOCK_TAGS && stack.last().tag == "p") stack.removeAt(stack.lastIndex)
            val el = HtmlElement(tag, attrs)
            stack.last().children += HtmlNode.Element(el)
            if (tag in RAW_TEXT) {
                // Skipped unread: its body is never parsed as markup.
                val closeTag = "</$tag"
                var j = i
                while (j < s.length && !s.regionMatches(j, closeTag, 0, closeTag.length, ignoreCase = true)) j++
                i = s.indexOf('>', j).let { if (it < 0) s.length else it + 1 }
                continue
            }
            if (!selfClosing && tag !in VOID) stack += el
        }
        flushText()
        return root
    }

    private fun closeOpen(tag: String, boundaries: Set<String>, stack: MutableList<HtmlElement>) {
        val k = stack.indexOfLast { it.tag == tag || it.tag in boundaries }
        if (k <= 0 || stack[k].tag != tag) return
        while (stack.size > k) stack.removeAt(stack.lastIndex)
    }

    private data class Tag(val name: String, val attrs: MutableMap<String, String>, val selfClosing: Boolean, val end: Int)

    private fun readTag(start: Int): Tag {
        var i = start
        val name = StringBuilder()
        while (i < s.length && !s[i].isWhitespace() && s[i] != '>' && s[i] != '/') name.append(s[i++])
        val attrs = mutableMapOf<String, String>()
        var selfClosing = false
        while (i < s.length) {
            val c = s[i]
            if (c == '>') {
                i++
                break
            }
            if (c == '/') {
                selfClosing = true
                i++
                continue
            }
            if (c.isWhitespace()) {
                i++
                continue
            }
            selfClosing = false
            val key = StringBuilder()
            while (i < s.length && !s[i].isWhitespace() && s[i] != '=' && s[i] != '>' && s[i] != '/') key.append(s[i++])
            while (i < s.length && s[i].isWhitespace()) i++
            val value = StringBuilder()
            if (i < s.length && s[i] == '=') {
                i++
                while (i < s.length && s[i].isWhitespace()) i++
                if (i < s.length && (s[i] == '"' || s[i] == '\'')) {
                    val q = s[i++]
                    while (i < s.length && s[i] != q) value.append(s[i++])
                    i++
                } else {
                    while (i < s.length && !s[i].isWhitespace() && s[i] != '>') value.append(s[i++])
                }
            }
            if (key.isNotEmpty()) attrs[key.toString().lowercase()] = decode(value.toString())
        }
        return Tag(name.toString().lowercase(), attrs, selfClosing, minOf(i, s.length))
    }
}
