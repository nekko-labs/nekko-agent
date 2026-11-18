package com.nekko.protocol

import java.text.Normalizer

/**
 * What a driver says to Nekko in the car, and which chat a spoken name means (#2782): the
 * iPhone's CarCommands.swift, pinned to the same cases by packages/shared/fixtures/car-commands.json.
 * Pure rules, no audio. There is no wake word: the driver asked to talk, so a leading "Nekko," is dropped.
 */
sealed interface CarCommand {
    /** "status", "what's happening", "what needs me". */
    data object Status : CarCommand
    /** "read Billing"; a null chat names the chat Talk was opened in. */
    data class Read(val chat: String?) : CarCommand
    /** "tell Billing to run the tests"; a null chat inside a chat's Talk. */
    data class Tell(val chat: String?, val message: String) : CarCommand
    data class Allow(val chat: String?) : CarCommand
    data class Deny(val chat: String?) : CarCommand
    data class Stop(val chat: String?) : CarCommand
    data class NewChat(val message: String) : CarCommand
    data object Yes : CarCommand
    data object No : CarCommand
    /** "the first one", "second", "3". */
    data class Pick(val n: Int) : CarCommand
    /** "say that again". */
    data object Again : CarCommand
    data class Unknown(val text: String) : CarCommand
}

object CarCommands {
    private fun rx(p: String) = Regex(p, RegexOption.IGNORE_CASE)

    private val wake = rx("""^(?:hey |ok |okay )?ne[ck][ck]?o\b[\s,:.!?-]*""")
    private val trailing = rx("""[\s.!?,]+$""")
    private val status = rx("""^(?:status|what(?:'s| is) (?:happening|going on|the status)|how(?:'s| is| are) (?:it|things|everything) going|what needs (?:me|my attention)|(?:does )?anything need me|any updates?|catch me up|give me (?:a |the )?(?:status|summary|rundown))$""")
    private val yes = rx("""^(?:yes|yeah|yep|yup|sure|confirm|do it|go ahead|send it|ok|okay|correct|please do|yes please)$""")
    private val no = rx("""^(?:no|nope|cancel|never ?mind|stop listening|forget it|don't|do not|no thanks)$""")
    private val again = rx("""^(?:say (?:that|it) again|repeat(?: that)?|again|what\??|come again|pardon)$""")
    private val pick = rx("""^(?:the )?(first|second|third|one|two|three|1|2|3|1st|2nd|3rd)(?: one)?$""")
    private val read = rx("""^(?:read(?: me)?(?: the latest(?: from| in)?| the reply(?: from| in)?)?|what did|what does|what has|what's|catch me up on|any news (?:from|on)|what's new (?:in|with|on))\s+(.+?)(?:\s+(?:say|said|saying|reply|replied|have to say|got to say|up to))?$""")
    private val readHere = rx("""^(?:read (?:it|that|the (?:latest|reply))(?: again)?|what did (?:it|they) say|read me the latest)$""")
    private val tell = rx("""^(?:tell|ask|message|reply to|send to|send)\s+(.+?)(?:\s*[:,]\s*|\s+(?:saying|that|to)\s+)(.+)$""")
    private val allow = rx("""^(?:allow|approve|accept|let it|let (?:it|them) run|go ahead with)(?:\s+(?:it|that|this))?(?:\s+(?:on|in|for))?(?:\s+(.+))?$""")
    private val deny = rx("""^(?:deny|reject|decline|don't allow|do not allow|block)(?:\s+(?:it|that|this))?(?:\s+(?:on|in|for))?(?:\s+(.+))?$""")
    private val stop = rx("""^(?:stop|halt|abort|cancel)\s+(?:the\s+)?(?:work (?:on|in)\s+)?(.+)$""")
    private val stopHere = rx("""^(?:stop|halt|abort)(?: it| that| this| working| the work)?$""")
    private val newChat = rx("""^(?:start|open|create|make|begin)(?: a| an)?(?: new)? (?:chat|agent|session|task)(?:\s+(?:to|that|which|about|and|for|on|:|,))?\s*(.+)$""")
    private val newChat2 = rx("""^new (?:chat|agent|session|task)(?:\s*[:,]|\s+(?:to|about|for))?\s+(.+)$""")
    private val ordinals = mapOf("first" to 1, "one" to 1, "1" to 1, "1st" to 1, "second" to 2, "two" to 2, "2" to 2, "2nd" to 2, "third" to 3, "three" to 3, "3" to 3, "3rd" to 3)

    /** A whole-string match's groups (as NSRegularExpression's firstMatch over an anchored pattern). */
    private fun Regex.groups(s: String): List<String>? = find(s)?.groupValues

    /** What one utterance means. [inChat]: anything that isn't a command is a message to that chat. */
    fun parse(text: String, inChat: Boolean = false): CarCommand {
        val said = text.trim().replace('’', '\'')
        val original = said.replace(wake, "").replace(trailing, "").trim()
        val c = original.lowercase()
        if (c.isEmpty()) return CarCommand.Unknown(said)
        if (yes.groups(c) != null) return CarCommand.Yes
        if (no.groups(c) != null) return CarCommand.No
        if (again.groups(c) != null) return CarCommand.Again
        pick.groups(c)?.let { g -> ordinals[g[1]]?.let { return CarCommand.Pick(it) } }
        if (status.groups(c) != null) return CarCommand.Status
        if (readHere.groups(c) != null) return CarCommand.Read(null)
        if (stopHere.groups(c) != null) return CarCommand.Stop(null)
        // New chat before tell: "start a chat to ..." must not read as "tell".
        (newChat.groups(original) ?: newChat2.groups(original))?.let { g -> g[1].trim().takeIf { it.isNotEmpty() }?.let { return CarCommand.NewChat(it) } }
        tell.groups(original)?.let { g ->
            val name = chatName(g[1]); val message = g[2].trim()
            if (name.isNotEmpty() && message.isNotEmpty()) return CarCommand.Tell(name, message)
        }
        allow.groups(c)?.let { return CarCommand.Allow(chatName(it[1]).ifEmpty { null }) }
        deny.groups(c)?.let { return CarCommand.Deny(chatName(it[1]).ifEmpty { null }) }
        stop.groups(c)?.let { return CarCommand.Stop(chatName(it[1]).ifEmpty { null }) }
        read.groups(c)?.let { g ->
            val name = chatName(g[1])
            if (name in setOf("it", "that", "they", "this")) return CarCommand.Read(null)
            if (name.isNotEmpty()) return CarCommand.Read(name)
        }
        return if (inChat) CarCommand.Tell(null, original) else CarCommand.Unknown(original)
    }

    private val namePrefix = rx("""^(?:the|my|our|a)\s+""")
    private val nameSuffix = rx("""\s+(?:chat|agent|session|one|task)$""")

    /** "the login chat" → "login". */
    private fun chatName(s: String) = s.trim().replace(namePrefix, "").replace(nameSuffix, "").trim()

    // Which chat a spoken name means

    data class ChatName(val id: String, val title: String)

    sealed interface Match {
        data class One(val id: String) : Match
        /** Close matches, best first (at most three), to read out as a choice. */
        data class Several(val ids: List<String>) : Match
        data object None : Match
    }

    /** Words that never tell two chats apart. */
    private val fillers = setOf("the", "a", "an", "chat", "agent", "session", "task", "one", "my", "our", "about", "on", "in", "for", "of", "to", "and", "with", "that", "this", "it")

    /** Lowercased, accent-free words without punctuation; "tests" counts as "test", "retries" as "retry". */
    fun words(s: String): List<String> {
        val folded = Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").lowercase()
        return folded.split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }.map { w ->
            when {
                w.length > 4 && w.endsWith("ies") -> w.dropLast(3) + "y"
                w.length > 3 && w.endsWith("s") && !w.endsWith("ss") -> w.dropLast(1)
                else -> w
            }
        }
    }

    /** How well [query] names [title], 0..1 plus a small bonus for an exact or near-exact title. */
    fun score(query: String, title: String): Double {
        val q = words(query).filter { it !in fillers }
        val t = words(title)
        if (q.isEmpty() || t.isEmpty()) return 0.0
        val hit = q.count { w -> t.any { it == w || (w.length >= 3 && it.startsWith(w)) || (it.length >= 3 && w.startsWith(it)) } }
        var score = hit.toDouble() / q.size
        if (words(query) == t) score += 0.5
        else if (score == 1.0) score += 0.25 * q.size / maxOf(t.count { it !in fillers }, q.size)
        return score
    }

    /** The single best match at least half named, the close ones when two are about as good, or none. */
    fun match(query: String, among: List<ChatName>): Match {
        val scored = among.map { it.id to score(query, it.title) }.filter { it.second >= 0.5 }.sortedByDescending { it.second }
        val best = scored.firstOrNull() ?: return Match.None
        val close = scored.filter { best.second - it.second < 0.2 }
        return if (close.size == 1) Match.One(best.first) else Match.Several(close.take(3).map { it.first })
    }
}
