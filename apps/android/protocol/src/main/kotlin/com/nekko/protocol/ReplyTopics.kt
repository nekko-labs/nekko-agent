package com.nekko.protocol

/**
 * The topics an agent's message can name (spec/chat/thinking-and-replies.md):
 * a line of its own, as a heading or a bold label, that says what follows. A
 * port of the desktop's `replyTopics.ts`, with the same tests.
 */
enum class Topic { QUESTION, NEXT, COMMAND, DECISION, SUMMARY }

/** A line that names a topic, and any words after the label (`**Next step**: merge it`). */
data class TopicLine(val topic: Topic, val label: String, val rest: String)

/** A run of a message under one header; the first has none unless the message opens on a label. */
data class TopicSection(val header: TopicLine?, val body: String)

/**
 * How a block of the agent's text reads: [WORKING] is a progress note,
 * [ATTENTION] a mid-turn message left for the reader, [REPLY] closes a turn
 * that did work. A reply with no steps before it has nothing to stand out
 * from, so it has no voice.
 */
enum class Voice { WORKING, ATTENTION, REPLY }

object ReplyTopics {
    // shortcut: English labels only, add translations once the prompt asks for them.
    private val TOPICS = listOf(
        Topic.QUESTION to Regex("^(open )?questions?( for you)?$|^decisions? needed$"),
        Topic.NEXT to Regex("^next steps?$|^what'?s next$|^action (needed|required)$|^your turn$"),
        Topic.COMMAND to Regex("^run this$|^commands?( to run)?$"),
        Topic.DECISION to Regex("^decisions?( made)?$|^assumptions?$"),
        Topic.SUMMARY to Regex("^summary$|^tl;?dr$|^changes$|^what changed$|^verified$|^not verified( / blocked)?$|^blocked$"),
    )
    private val HEADING = Regex("""^#{1,6}\s+(.+?)\s*#*$""")
    private val BOLD = Regex("""^\*\*([^*]+?)(:?)\*\*(:?)\s*(.*)$""")
    private val QUESTION_END = Regex("""[?？][*_`)"'”’]*$""")
    private val FENCE = "```"

    private fun topicOf(label: String): Topic? {
        val name = label.trim().lowercase()
        return TOPICS.firstOrNull { (_, pattern) -> pattern.containsMatchIn(name) }?.first
    }

    fun topicLine(line: String): TopicLine? {
        val text = line.trim()
        HEADING.matchEntire(text)?.let { m ->
            val label = m.groupValues[1].replace("**", "").removeSuffix(":")
            return topicOf(label)?.let { TopicLine(it, label, "") }
        }
        val bold = BOLD.matchEntire(text) ?: return null
        val (label, colonIn, colonOut, rest) = bold.destructured
        // `**Changes** to the plan` is emphasis in a sentence, not a label.
        if (rest.isNotEmpty() && colonIn.isEmpty() && colonOut.isEmpty()) return null
        return topicOf(label)?.let { TopicLine(it, label.trim(), rest) }
    }

    /** The text without its code fences, which can hold anything, by paragraph. */
    private fun paragraphs(text: String): List<List<String>> {
        val prose = text.split(FENCE).filterIndexed { i, _ -> i % 2 == 0 }.joinToString("\n\n")
        return prose.split(Regex("""\n\s*\n""")).map { p -> p.split('\n').filter { it.isNotBlank() } }.filter { it.isNotEmpty() }
    }

    private fun endsInQuestion(lines: List<String>?): Boolean = QUESTION_END.containsMatchIn(lines?.lastOrNull()?.trim() ?: "")

    /** True when a message written mid-turn is addressed to the reader: it names a topic, or it stops on a question. */
    fun speaksToUser(text: String): Boolean {
        val blocks = paragraphs(text)
        return endsInQuestion(blocks.lastOrNull()) || blocks.any { p -> p.any { topicLine(it) != null } }
    }

    /** True when a message closes on a question that no label already announces. */
    fun endsOnUnlabelledQuestion(text: String): Boolean {
        val blocks = paragraphs(text)
        if (!endsInQuestion(blocks.lastOrNull()) || blocks.last().any { topicLine(it) != null }) return false
        return blocks.flatten().none { topicLine(it)?.topic.let { t -> t == Topic.QUESTION || t == Topic.NEXT } }
    }

    /** The voice of text the agent wrote with more of its turn still to come. */
    fun midTurnVoice(text: String): Voice = if (speaksToUser(text)) Voice.ATTENTION else Voice.WORKING

    /**
     * A message cut at its topic lines (outside code), each section to draw
     * under a header. With [askTail], a closing question no label announces
     * gets a Question header over its paragraph.
     */
    fun sections(text: String, askTail: Boolean = false): List<TopicSection> {
        val lines = text.split('\n')
        val ask = if (askTail && endsOnUnlabelledQuestion(text)) lastParagraph(lines) else -1
        val out = ArrayList<TopicSection>()
        var header: TopicLine? = null
        val body = ArrayList<String>()
        fun flush() {
            val s = body.joinToString("\n").trim('\n')
            if (header != null || s.isNotBlank()) out += TopicSection(header, s)
            body.clear()
        }
        var fence = false
        lines.forEachIndexed { i, line ->
            val topic = if (fence) null else topicLine(line)
            if (line.trim().startsWith(FENCE)) fence = !fence
            when {
                topic != null -> { flush(); header = topic; if (topic.rest.isNotEmpty()) body += topic.rest }
                i == ask -> { flush(); header = TopicLine(Topic.QUESTION, "Question", ""); body += line }
                else -> body += line
            }
        }
        flush()
        return out
    }

    /** Where the last paragraph of prose starts, outside code fences. */
    private fun lastParagraph(lines: List<String>): Int {
        var start = -1
        var fence = false
        var gap = true
        lines.forEachIndexed { i, line ->
            when {
                line.trim().startsWith(FENCE) -> { fence = !fence; gap = true }
                fence -> {}
                line.isBlank() -> gap = true
                gap -> { start = i; gap = false }
            }
        }
        return start
    }

    /**
     * Each block's voice, by its place in its turn: text with more of the turn
     * after it is a note or a message for the reader; the turn's last text is
     * the reply once the turn is over. [running] says the newest turn is live,
     * so its last text has no voice yet.
     */
    fun voices(blocks: List<Block>, running: Boolean = false): List<Voice?> {
        val out = MutableList<Voice?>(blocks.size) { null }
        val users = blocks.indices.filter { blocks[it] is Block.User }
        for ((a, b) in (listOf(-1) + users + blocks.size).zipWithNext()) {
            val worked = (a + 1 until b).any { blocks[it] is Block.Tool }
            for (i in a + 1 until b) {
                val block = blocks[i] as? Block.Assistant ?: continue
                if (block.text.isBlank()) continue
                out[i] = when {
                    i < b - 1 -> midTurnVoice(block.text)
                    block.streaming || !worked || (running && b == blocks.size) -> null
                    else -> Voice.REPLY
                }
            }
        }
        return out
    }
}
