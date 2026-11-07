package com.nekko.protocol

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AuditTest {
    // As the computer sends it (crates/nekkod/src/audit.rs, `audit:read`).
    private val raw = Json.parseToJsonElement(
        """
        [
          {"at":1,"turnId":"t1","type":"turn","mode":"guardrails","model":"qwen3-8b"},
          {"at":2,"turnId":"t1","type":"tool","tool":"read_file","ms":3,"detail":{"path":"app.ts"}},
          {"at":3,"turnId":"t1","type":"approval","tool":"mcp__srv__post_message","severity":"high","answer":"approved","by":{"via":"phone","device":"d1","deviceName":"Davide's Pixel"}},
          {"at":4,"turnId":"t1","type":"tool","tool":"mcp__srv__post_message","ms":9,"detail":{"server":"srv","recipients":1}},
          {"at":5,"turnId":"t1","type":"taint","by":"mcp__srv__post_message"},
          {"at":6,"turnId":"t1","type":"something-new","x":1},
          {"at":7,"turnId":"t2","type":"turn","mode":"yolo"},
          {"at":8,"turnId":"t2","type":"approval","tool":"bash","answer":"approved","by":{"via":"yolo"}},
          {"at":9,"turnId":"t2","type":"redactions","counts":{"PII_EMAIL":2}},
          {"at":10,"turnId":"t2","type":"approval","tool":"fetch_url","answer":"denied","by":{"via":"paired computer","device":"gone","deviceName":" "}}
        ]
        """,
    )

    @Test
    fun parsesTheTrailAndSkipsWhatItDoesNotKnow() {
        val trail = Audit.parse(raw)
        assertEquals("the unknown event is skipped", 9, trail.size)
        val tool = trail[3] as Audit.Tool
        assertEquals(listOf("server srv"), tool.touched)
        assertEquals(1, tool.recipients)
        val approval = trail[2] as Audit.Approval
        assertEquals(Audit.Answer.APPROVED, approval.answer)
        assertEquals("Davide's Pixel", approval.by?.name)
        assertNull("a blank name is no name", (trail[8] as Audit.Approval).by?.name)
        assertEquals(listOf("PII_EMAIL" to 2), (trail[7] as Audit.Redactions).counts)
        assertTrue(Audit.parse(null).isEmpty())
    }

    @Test
    fun showsNewestTurnFirstAndCanKeepOnlyTheDecisions() {
        val trail = Audit.parse(raw)
        val all = Audit.shown(trail, onlyDecisions = false)
        assertEquals(listOf("t2", "t1"), all.map { it.turnId })
        assertEquals("guardrails", all[1].start?.mode)
        assertEquals(4, all[1].events.size)
        val decisions = Audit.shown(trail, onlyDecisions = true)
        assertEquals(listOf(listOf(8L, 10L), listOf(3L)), decisions.map { g -> g.events.map { it.at } })
    }

    @Test
    fun marksYoloAndOutsideContentAsWarnings() {
        val trail = Audit.parse(raw)
        assertEquals(Audit.Tone.GOOD, Audit.tone(trail[2]))
        assertEquals(Audit.Tone.WARN, Audit.tone(trail[4]))
        assertEquals(Audit.Tone.WARN, Audit.tone(trail[6]))
        assertEquals(Audit.Tone.BAD, Audit.tone(trail[8]))
    }
}
