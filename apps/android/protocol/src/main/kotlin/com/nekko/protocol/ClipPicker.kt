package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.util.Locale

/**
 * A paid cloud clip's choice (#3038): an ordinary `ask_user` question request carrying
 * `clip: { model, via, sendsPicture, prices }`. Length, Audio and Resolution are the questions'
 * headers (each may be absent); [prices] maps `"<length>|<audio>|<resolution>"` (empty for an
 * absent question) to dollars. The first option of each question is the suggestion. The iPhone
 * and the desktop's `ClipPicker.tsx` read the same fields.
 */
data class ClipOffer(
    val model: String,
    val via: String,
    val sendsPicture: Boolean,
    val prices: Map<String, Double>,
) {
    companion object {
        fun from(e: JsonElement?): ClipOffer? {
            val o = e.obj() ?: return null
            val prices = o["prices"].obj()?.mapNotNull { (k, v) ->
                ((v as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull)?.takeIf { it.isFinite() }?.let { k to it }
            }?.toMap() ?: emptyMap()
            return ClipOffer(o.str("model") ?: return null, o.str("via") ?: return null, o.bool("sendsPicture"), prices)
        }
    }
}

/** The clip card's state and answers, pure (the desktop's `suggestedPicks`, `clipTotal`, `clipAnswers`). */
object ClipPicker {
    private val HEADERS = listOf("Length", "Audio", "Resolution")

    /** The first option of each question: the computer puts the suggested one first. */
    fun suggestedPicks(request: AskRequest): Map<String, String> =
        request.questions.associate { it.id to (it.options.firstOrNull()?.label ?: "") }

    /** The total for these picks from the request's price table; null when that combination is not priced. */
    fun total(request: AskRequest, picks: Map<String, String>): Double? {
        val clip = request.clip ?: return null
        val key = HEADERS.joinToString("|") { header ->
            request.questions.firstOrNull { it.header == header }?.let { picks[it.id] ?: "" } ?: ""
        }
        return clip.prices[key]
    }

    /** Dollars as the card says them: `$2.40`. */
    fun usd(n: Double): String = "$" + String.format(Locale.US, "%.2f", n)

    /** The answers the computer reads: each question's pick, then the confirmed total with two decimals. */
    fun answers(request: AskRequest, picks: Map<String, String>, total: Double): List<AskAnswer> =
        request.questions.map { AskAnswer(it.id, listOf(picks[it.id] ?: "")) } +
            AskAnswer("total", listOf(String.format(Locale.US, "%.2f", total)))
}
