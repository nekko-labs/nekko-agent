package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** The paid clip card's logic, held to the desktop's ClipPicker.test.tsx (#3038). */
class ClipPickerTest {
    private val json = """
        {"callId":"c_veo-clip","askedAt":1,"questions":[
          {"id":"q1","header":"Length","question":"How long?","options":[{"label":"4 seconds"},{"label":"6 seconds"},{"label":"8 seconds"}]},
          {"id":"q2","header":"Audio","question":"Sound?","options":[{"label":"No audio"},{"label":"With audio"}]},
          {"id":"q3","header":"Resolution","question":"Resolution?","options":[{"label":"720p"},{"label":"1080p"}]}],
         "clip":{"model":"Veo 3.1","via":"OpenRouter","sendsPicture":false,"prices":{
           "4 seconds|No audio|720p":0.8,"6 seconds|No audio|720p":1.2,"6 seconds|With audio|720p":2.4,"8 seconds|With audio|1080p":3.2,"bad":"free"}}}
    """.trimIndent()
    private val request = AskRequest.from(WireJson.parseToJsonElement(json))!!

    @Test fun `reads the clip offer and its price table`() {
        val clip = request.clip!!
        assertEquals("Veo 3.1", clip.model)
        assertEquals("OpenRouter", clip.via)
        assertEquals(false, clip.sendsPicture)
        assertEquals(4, clip.prices.size)
        assertEquals(2.4, clip.prices["6 seconds|With audio|720p"]!!, 0.0)
    }

    @Test fun `an ordinary question has no clip, and an incomplete clip is ignored`() {
        assertNull(AskRequest.from(WireJson.parseToJsonElement("""{"callId":"c","questions":[],"askedAt":1}"""))!!.clip)
        assertNull(AskRequest.from(WireJson.parseToJsonElement("""{"callId":"c","questions":[],"askedAt":1,"clip":{"via":"x"}}"""))!!.clip)
        assertNotNull(request.clip)
    }

    @Test fun `starts on the suggested clip, the first option of each question`() {
        val picks = ClipPicker.suggestedPicks(request)
        assertEquals(mapOf("q1" to "4 seconds", "q2" to "No audio", "q3" to "720p"), picks)
        assertEquals(0.8, ClipPicker.total(request, picks)!!, 0.0)
    }

    @Test fun `prices each combination and says when one is not priced`() {
        assertEquals(2.4, ClipPicker.total(request, mapOf("q1" to "6 seconds", "q2" to "With audio", "q3" to "720p"))!!, 0.0)
        assertNull(ClipPicker.total(request, mapOf("q1" to "8 seconds", "q2" to "No audio", "q3" to "1080p")))
        assertNull(ClipPicker.total(AskRequest("c", emptyList(), 1), emptyMap()))
    }

    @Test fun `an absent question is the empty part of the price key`() {
        val no = request.copy(
            questions = request.questions.filter { it.header != "Audio" },
            clip = request.clip!!.copy(prices = mapOf("4 seconds||720p" to 0.5)),
        )
        assertEquals(0.5, ClipPicker.total(no, ClipPicker.suggestedPicks(no))!!, 0.0)
    }

    @Test fun `answers with each pick and the total at two decimals`() {
        val answers = ClipPicker.answers(request, mapOf("q1" to "6 seconds", "q2" to "With audio", "q3" to "720p"), 2.4)
        assertEquals(
            listOf("q1" to "6 seconds", "q2" to "With audio", "q3" to "720p", "total" to "2.40"),
            answers.map { it.questionId to it.labels.single() },
        )
        assertEquals("$2.40", ClipPicker.usd(2.4))
        assertEquals("$0.80", ClipPicker.usd(0.8))
    }
}
