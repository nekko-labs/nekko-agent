package com.nekko.protocol

import java.security.MessageDigest

/**
 * The rules for drawing a ```` ```mermaid ```` fence on the phone (MM-4, the
 * iPhone's `MermaidRules`), kept apart from the WebView renderer so they are
 * tested on the JVM: which fences are diagrams, when one may be drawn, the
 * size cap, and the cache key.
 */
object MermaidRules {
    /** Longer sources fall back to their code with "Too large to draw on the phone". */
    const val MAX_SOURCE = 50_000
    /** A render that takes longer than this falls back the same way. */
    const val TIMEOUT_MS = 5_000L
    /** Rendered widths are rounded down to steps of this many dp, so a rotation or a fold doesn't draw every diagram again. */
    const val WIDTH_STEP = 40

    enum class Decision {
        /** The fence is closed and small enough: draw it. */
        DRAW,
        /** A streaming reply has not closed the fence yet: show the source, draw later. */
        WAIT_FOR_FENCE,
        TOO_LARGE,
    }

    /** A fence's language says Mermaid (```` ```mermaid ````, any case). */
    fun isMermaid(language: String): Boolean = language.lowercase().let { it == "mermaid" || it == "mmd" }

    /** `.mmd` and `.mermaid` files. */
    fun isMermaidFile(name: String): Boolean = name.lowercase().let { it.endsWith(".mmd") || it.endsWith(".mermaid") }

    /** What to do with a Mermaid fence. Never draw before the fence closes, so a streaming reply renders the diagram once, not once per token. */
    fun decide(source: String, closed: Boolean): Decision = when {
        !closed -> Decision.WAIT_FOR_FENCE
        source.length > MAX_SOURCE -> Decision.TOO_LARGE
        else -> Decision.DRAW
    }

    /** The width a diagram is drawn at for a space [width] dp wide. */
    fun drawWidth(width: Double): Int = maxOf(WIDTH_STEP, width.toInt() / WIDTH_STEP * WIDTH_STEP)

    /** The cache key for one drawing: the source, the theme and the width step, and the renderer's version, so a new bundled Mermaid draws afresh. */
    fun cacheKey(source: String, dark: Boolean, width: Int, version: String): String {
        val material = "mermaid|$version|${if (dark) "dark" else "light"}|$width|$source"
        return MessageDigest.getInstance("SHA-256").digest(material.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    private val NAMES = mapOf(
        "graph" to "flowchart", "flowchart" to "flowchart", "sequencediagram" to "sequence diagram",
        "classdiagram" to "class diagram", "statediagram" to "state diagram", "statediagram-v2" to "state diagram",
        "erdiagram" to "entity relationship diagram", "gantt" to "Gantt chart", "pie" to "pie chart",
        "journey" to "user journey", "gitgraph" to "git graph", "mindmap" to "mind map", "timeline" to "timeline",
        "quadrantchart" to "quadrant chart", "xychart-beta" to "chart", "sankey-beta" to "Sankey diagram",
        "requirementdiagram" to "requirement diagram", "c4context" to "C4 diagram", "block-beta" to "block diagram",
        "architecture-beta" to "architecture diagram", "kanban" to "kanban board", "packet-beta" to "packet diagram",
    )

    /** The diagram's kind for TalkBack ("Diagram, flowchart"), from its first keyword. */
    fun kind(source: String): String {
        val first = source.split('\n', '\r').map { it.trim() }.firstOrNull { it.isNotEmpty() && !it.startsWith("%%") && it != "---" }.orEmpty()
        return NAMES[first.split(' ').first().lowercase()] ?: "diagram"
    }
}
