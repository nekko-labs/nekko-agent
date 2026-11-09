package com.nekko.android.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/**
 * The in-chat GitHub star ask (spec/platform/github-star-ask.md): a card under the reply
 * to the 10th and the 50th prompt sent from this phone. A port of the rules in
 * `packages/shared/src/support.ts` (`STAR_ASK_AT`, `countStarAskPrompt`, `starAskDue`,
 * `markStarAskShown`, `stopStarAsk`): change the numbers or a rule there and here together.
 */
data class StarAskState(
    /** Prompts sent from this phone that got a finished reply. */
    val prompts: Int = 0,
    /** How many times the card has been shown. */
    val asked: Int = 0,
    /** Starred (opened GitHub) or "Don't ask again": never ask again. */
    val stopped: Boolean = false,
) {
    /** One more prompt got its reply. */
    fun counted(): StarAskState = copy(prompts = prompts + 1)

    /** Whether the reply that just finished should carry the card. */
    fun due(): Boolean {
        if (stopped) return false
        val at = StarAsk.AT.getOrNull(asked) ?: return false
        return prompts >= at
    }

    /**
     * The card was shown: this ask is used up whatever happens next (ignoring it is
     * "Not now"), and so is any later one whose count is already reached, so two asks
     * never come back to back.
     */
    fun shown(): StarAskState = copy(asked = maxOf(asked + 1, StarAsk.AT.count { prompts >= it }))

    /** Starred or "Don't ask again": never again. */
    fun stop(): StarAskState = copy(stopped = true)

    /** The same JSON the desktop keeps in `localStorage` (`{prompts, asked, stopped?}`). */
    fun encode(): String = buildJsonObject {
        put("prompts", prompts)
        put("asked", asked)
        if (stopped) put("stopped", true)
    }.toString()

    companion object {
        /** A stored state; anything malformed reads as a fresh start (`parseStarAsk`). */
        fun decode(raw: String?): StarAskState {
            val o = runCatching { Json.parseToJsonElement(raw ?: "") as? JsonObject }.getOrNull() ?: return StarAskState()
            fun n(key: String): Int {
                val d = (o[key] as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull ?: return 0
                return if (d.isFinite() && d >= 0) minOf(d, Int.MAX_VALUE.toDouble()).toInt() else 0
            }
            val stopped = (o["stopped"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull == true
            return StarAskState(n("prompts"), n("asked"), stopped)
        }
    }
}

/**
 * Where the phone keeps the ask: [PhonePrefs] on this device only (preferences are left out
 * of backup and device transfer), never synced, never sent to the computer or Nekko Labs.
 */
class StarAsk(private val prefs: PhonePrefs) {
    fun read(): StarAskState = StarAskState.decode(prefs.get(KEY))

    private fun write(state: StarAskState) = prefs.set(KEY, state.encode())

    /**
     * A prompt sent from this phone got its finished reply. Counts it and says whether that
     * reply carries the card; when it does the ask is used up now, so ignoring it is Not now.
     */
    fun afterReply(): Boolean {
        val counted = read().counted()
        val due = counted.due()
        write(if (due) counted.shown() else counted)
        return due
    }

    /** Star on GitHub or Don't ask again. */
    fun stop() = write(read().stop())

    companion object {
        /** The prompt counts that ask, the same as `STAR_ASK_AT` on the desktop. */
        val AT: List<Int> = listOf(10, 50)

        val KEY = PhonePrefs.string("star_ask", default = "")

        /** The repository the card opens. */
        const val REPO_URL = com.nekko.android.feedback.Feedback.REPO_URL

        /**
         * The app's own store, or null under instrumentation: device and screenshot tests
         * never see the card unless they pass a [StarAsk] themselves.
         */
        fun forApp(prefs: PhonePrefs?): StarAsk? = if (prefs == null || underInstrumentation) null else StarAsk(prefs)

        private val underInstrumentation: Boolean by lazy {
            runCatching { Class.forName("androidx.test.platform.app.InstrumentationRegistry") }.isSuccess
        }
    }
}
