package com.nekko.protocol

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class CardDetailsTest {
    @Test fun preferencesMigrateAndRoundTrip() {
        val old = ChatListView.parse("""{"showEmptyGroups":true,"showPreviews":false}""")
        assertTrue(old.showEmptyGroups)
        assertFalse(old.showPreviews)
        assertTrue(old.showModel && old.showContext && old.showPullRequests && old.showUpdated)
        val hidden = ChatListView.STANDARD.copy(showModel = false, showContext = false, showPullRequests = false, showUpdated = false)
        assertEquals(hidden, ChatListView.parse(hidden.encoded()))
        assertFalse(hidden.isStandard)
        val invalid = ChatListView.parse("""{"showContext":"false","showModel":false}""")
        assertTrue(invalid.showContext)
        assertFalse(invalid.showModel)
        assertFalse(ChatListView.STANDARD.showEmptyGroups)
    }

    @Test fun contextMatchesOnlyItsOwnModel() {
        fun summary(model: String) = SessionSummary.from(Json.parseToJsonElement("""{"id":"a","modelId":"$model","transcriptTokens":100,"prUrls":["https://github.com/o/r/pull/7"],"claudeCodeContext":{"modelId":"opus","used":42000,"window":200000}}"""))!!
        assertEquals(42000L, summary("opus").contextUsed)
        assertEquals(200000L, summary("opus").contextWindow)
        assertNull(summary("sonnet").contextUsed)
        assertNull(summary("sonnet").contextWindow)
        assertEquals(100L, summary("sonnet").transcriptTokens)
        assertEquals(listOf("https://github.com/o/r/pull/7"), summary("opus").prUrls)
    }
}
