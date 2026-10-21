package com.nekko.android.chat

import com.nekko.protocol.SkillSummary

/**
 * The composer's `/` menu, without Android: when the message box starts with
 * `/` and no space yet, or ends in a `/word` typed after a space or line break,
 * the computer's skills are offered, filtered by name or description (as the
 * desktop's `matchSkills`). Picking one arms it and removes only the `/word`;
 * the rest of the box becomes the skill's input.
 */
object SkillMenu {
    /** The `/query` being typed and where its `/` sits in the box. */
    data class Trigger(val query: String, val start: Int)

    // A `/word` at the very end, after whitespace, as on the desktop: `a/b` and URLs don't count.
    // `\z`, not `$`: Java's `$` also matches before a final line break.
    private val trailing = Regex("""(?:^|\s)/([^\s/]*)\z""")

    /**
     * The `/query` being typed, or null when the box isn't asking for a skill.
     * A box starting with `/` asks until its first space, as before; otherwise
     * only a `/word` at the end of the text, after a space or line break, asks.
     */
    fun trigger(text: String): Trigger? {
        if (text.startsWith("/")) {
            val rest = text.substring(1)
            return if (rest.any { it.isWhitespace() }) null else Trigger(rest, 0)
        }
        val q = trailing.find(text)?.groupValues?.get(1) ?: return null
        return Trigger(q, text.length - q.length - 1)
    }

    /** The `/query` being typed, or null when the box isn't asking for a skill. */
    fun query(text: String): String? = trigger(text)?.query

    /** The box once a skill is picked: the `/query` goes, anything typed before it stays. */
    fun afterPick(text: String): String = trigger(text)?.let { text.substring(0, it.start) } ?: text

    /** Skills matching [query], names that start with it first, then the computer's order. */
    fun match(skills: List<SkillSummary>, query: String): List<SkillSummary> {
        val q = query.lowercase()
        return skills
            .filter { it.name.lowercase().contains(q) || it.description.lowercase().contains(q) }
            .sortedBy { if (it.name.lowercase().startsWith(q)) 0 else 1 }
    }

    /**
     * `/name rest` typed out in full: the armed skill and the remaining text,
     * so a skill can be run without opening the menu. Null when no such skill.
     */
    fun typed(text: String, skills: List<SkillSummary>): Pair<SkillSummary, String>? {
        if (!text.startsWith("/")) return null
        val name = text.substring(1).takeWhile { !it.isWhitespace() }
        val skill = skills.firstOrNull { it.name == name } ?: return null
        return skill to text.substring(1 + name.length).trim()
    }

    /** A short label for where the skill comes from, shown beside its name. */
    fun sourceLabel(source: String): String = when (source) {
        "builtin" -> "Built in"
        "marketplace" -> "Marketplace"
        "claude" -> "Claude Code"
        "codex" -> "Codex"
        "gemini" -> "Gemini"
        "agents" -> "Agents"
        else -> source
    }
}
