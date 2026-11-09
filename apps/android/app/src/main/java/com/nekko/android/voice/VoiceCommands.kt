package com.nekko.android.voice

import java.util.Locale

sealed interface VoiceIntent {
    data class Dictation(val text: String) : VoiceIntent
    data class Unknown(val text: String) : VoiceIntent
    data class Navigate(val view: String) : VoiceIntent
    data class Go(val target: String) : VoiceIntent
    data class OpenChat(val query: String, val text: String) : VoiceIntent
    data class Pick(val n: Int) : VoiceIntent
    data object NewSession : VoiceIntent
    data object CompleteSession : VoiceIntent
    data object Erase : VoiceIntent
    data object Clear : VoiceIntent
    data object Send : VoiceIntent
    data object Status : VoiceIntent
    data object Ship : VoiceIntent
    data object Yes : VoiceIntent
    data object No : VoiceIntent
}

/** Grammar twin of iOS VoiceCommands and the shared voice-commands.json fixture. */
object VoiceCommands {
    private fun rx(s: String) = Regex(s, RegexOption.IGNORE_CASE)
    private val wake = rx("""^ne[ck][ck]?o\b[\s,:.!?-]*""")
    private val wakeOnly = rx("""^ne[ck][ck]?o\b[\s,:.!?-]*$""")
    private val trailing = Regex("""[.!?]+$""")
    private val newSession = rx("""^(?:(?:create|start|open)(?: a)? new (?:session|chat|agent)|new (?:agent )?(?:session|chat|agent)|let's (?:make|start|create) a new (?:change|session|chat|task))$""")
    private val complete = rx("""^(?:complete|finish|archive) (?:this|the current) (?:session|chat|agent)$""")
    private val picks = mapOf("first" to 1, "one" to 1, "1" to 1, "second" to 2, "two" to 2, "2" to 2, "third" to 3, "three" to 3, "3" to 3)
    private val numbers = mapOf("one" to 1, "two" to 2, "to" to 2, "too" to 2, "three" to 3, "four" to 4, "for" to 4, "five" to 5, "six" to 6, "seven" to 7, "eight" to 8, "nine" to 9)
    private val views = mapOf("agent board" to "command", "command center" to "command", "agents" to "command", "models" to "models", "model providers" to "models", "model server" to "modelserver", "settings" to "settings", "connectors" to "connectors", "memory" to "memory", "skills" to "skills", "training" to "training", "workflows" to "workflows", "design" to "design", "artifacts" to "artifacts")
    private val simple = listOf(
        rx("""^(?:erase|scratch|cancel|undo) that$""") to VoiceIntent.Erase,
        rx("""^clear(?: everything| all| it)?$""") to VoiceIntent.Clear,
        rx("""^send(?: it| that)?$""") to VoiceIntent.Send,
        rx("""^ship(?: it| that)?$""") to VoiceIntent.Ship,
        rx("""^(?:status|how(?:'s| is) it going|what's the status)$""") to VoiceIntent.Status,
        rx("""^(?:yes|yeah|yep|confirm|do it)$""") to VoiceIntent.Yes,
        rx("""^(?:no|nope|cancel|never ?mind)$""") to VoiceIntent.No,
    )

    fun parse(text: String): VoiceIntent {
        val trimmed = text.trim()
        val address = wake.find(trimmed) ?: return VoiceIntent.Dictation(trimmed)
        val command = trimmed.substring(address.range.last + 1).lowercase(Locale.ROOT).replace('\u2019', '\'').replace(trailing, "").trim()
        if (newSession.matches(command)) return VoiceIntent.NewSession
        if (complete.matches(command)) return VoiceIntent.CompleteSession
        simple.firstOrNull { it.first.matches(command) }?.let { return it.second }
        rx("""^(?:the )?(first|second|third|one|two|three|1|2|3)(?: one)?$""").find(command)?.let { return VoiceIntent.Pick(picks.getValue(it.groupValues[1])) }
        rx("""^(?:go to |switch to |move to )?(?:the )?(next|previous|last) (?:desktop|space)$""").find(command)?.let {
            return VoiceIntent.Go("desktop:${if (it.groupValues[1] == "next") 1 else -1}")
        }
        rx("""^(?:go to|switch(?: to)?|move to|show) (?:the )?(desktop|space|screen|monitor|display) (\w+)$""").find(command)?.let {
            val n = it.groupValues[2].toIntOrNull() ?: numbers[it.groupValues[2]] ?: 0
            if (n in 1..16) return VoiceIntent.Go("${if (it.groupValues[1] in listOf("desktop", "space")) "desktop" else "screen"}:$n")
        }
        val target = command.replace(rx("""^(?:go to|open|show|switch to) (?:the )?"""), "").replace(rx(""" (?:tab|page)$"""), "")
        if (target != command) views[target]?.let { return VoiceIntent.Navigate(it) }
        val chat = rx("""^open the (?:other )?one (?:about|related to|on) (.+)$""").find(command)
            ?: rx("""^(?:switch to|open) (.+)$""").find(command)
        if (chat != null) {
            val query = chat.groupValues[1].replace(rx("""^(?:the|a) """), "")
            if (views[query.replace(rx(""" (?:tab|page)$"""), "")] == null && !rx("""^(?:desktop|space|screen|monitor|display)""").containsMatchIn(query)) return VoiceIntent.OpenChat(query, trimmed)
        }
        return VoiceIntent.Unknown(trimmed)
    }

    fun spellNekko(text: String) = text.replace(rx("""\bne[ck][ck]?o\b"""), "Nekko")

    fun split(text: String): List<VoiceIntent> {
        val pieces = text.split(Regex("""(?<=[.!?])\s+""")).filter { it.isNotBlank() }
        val out = mutableListOf<VoiceIntent>()
        var i = 0
        while (i < pieces.size) {
            var piece = pieces[i++]
            if (wakeOnly.matches(piece.trim()) && i < pieces.size) piece += " " + pieces[i++]
            val intent = parse(piece)
            val last = out.lastOrNull()
            if (intent is VoiceIntent.Dictation && last is VoiceIntent.Dictation) out[out.lastIndex] = VoiceIntent.Dictation(last.text + " " + intent.text)
            else out.add(intent)
        }
        return out
    }

    data class WakeTail(val rest: String, val wake: String)
    fun splitWakeTail(text: String): WakeTail {
        val trimmed = text.trim()
        val match = rx("""(?:^|(?<=[.!?])\s+)(ne[ck][ck]?o\b[\s,:.!?-]*)$""").find(trimmed)
            ?: return WakeTail(trimmed, "")
        return WakeTail(trimmed.substring(0, match.range.first).trim(), match.groupValues[1].trim())
    }
}
