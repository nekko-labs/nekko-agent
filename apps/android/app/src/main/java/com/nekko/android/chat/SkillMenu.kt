package com.nekko.android.chat

import com.nekko.protocol.SkillSummary

/**
 * The composer's `/` menu, without Android: when the message box starts with
 * `/` and no space yet, the computer's skills are offered, filtered by name or
 * description (as the desktop's `matchSkills`). Picking one arms it, and the
 * rest of the box becomes the skill's input.
 */
object SkillMenu {
    /** The `/query` being typed, or null when the box isn't asking for a skill. */
    fun query(text: String): String? {
        if (!text.startsWith("/")) return null
        val rest = text.substring(1)
        return if (rest.any { it.isWhitespace() }) null else rest
    }

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
