package com.nekko.android.voice

import org.junit.Assert.*
import org.junit.Test

class VoiceSpeechTest {
    @Test fun `long replies preserve all text while respecting engine cap`() {
        val text = "Hello world. ".repeat(1000)
        val chunks = VoiceSpeech.chunks(text, 128)
        assertTrue(chunks.size > 1)
        assertTrue(chunks.all { it.length in 1..128 })
        assertEquals(text, chunks.joinToString(""))
    }
    @Test fun `unbroken unicode words never split surrogate pairs`() {
        val text = "a" + "\uD83D\uDE00".repeat(40)
        val chunks = VoiceSpeech.chunks(text, 8)
        assertEquals(text, chunks.joinToString(""))
        assertTrue(chunks.all { it.length <= 8 && !it.last().isHighSurrogate() && !it.first().isLowSurrogate() })
    }
    @Test fun `empty and short replies need no empty utterance`() {
        assertTrue(VoiceSpeech.chunks("", 10).isEmpty())
        assertEquals(listOf("hello"), VoiceSpeech.chunks("hello", 10))
    }
}
