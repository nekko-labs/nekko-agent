package com.nekko.android.ui.screens

import com.nekko.android.chat.ChatProjector
import com.nekko.protocol.Session
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class TurnStrategyRowsTest {
    @Test fun `strategy sections sit before their prompts in detailed and folded transcripts`() {
        val session = Session.from(Json.parseToJsonElement("""{"id":"s","messages":[
            {"id":"old","role":"user","content":"Older chat"},
            {"id":"u1","role":"user","content":"Check it","turnStrategy":{"tools":"code","orchestration":"direct"}},
            {"id":"a","role":"assistant","content":"Okay","reasoning":"Checking"},
            {"id":"u2","role":"user","content":"Then plan","turnStrategy":{"tools":"code","orchestration":"coordinator"}}
        ]}"""))!!
        val projector = ChatProjector()
        val blocks = projector.blocks(session, emptyList())
        val keyed = TranscriptCache().keyed(blocks, projector.layout)
        for ((showSteps, open) in listOf(true to emptySet(), false to emptySet(), false to setOf("assistant:a"))) {
            val rows = transcriptRows(keyed, showSteps, running = false, open = open, strategies = projector.strategies)
            assertEquals(
                listOf("user:old", "strategy:user:u1", "user:u1", "assistant:a", "strategy:user:u2", "user:u2"),
                rows.filterNot { it is TranscriptRow.Steps }.map(::rowKey),
            )
        }
    }
}
