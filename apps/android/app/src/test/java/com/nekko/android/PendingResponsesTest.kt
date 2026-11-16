package com.nekko.android

import com.nekko.android.data.PendingResponses
import com.nekko.android.data.ResponseMessage
import com.nekko.android.data.ResponseMessage.Status
import com.nekko.protocol.Approval
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.AskOption
import com.nekko.protocol.AskQuestion
import com.nekko.protocol.AskRequest
import com.nekko.protocol.Channels
import com.nekko.protocol.OfflineFiles
import com.nekko.protocol.RelayException
import com.nekko.protocol.Severity
import com.nekko.protocol.ToolCall
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Answers and approvals kept until the computer takes them, bound to the request seen (#2497, decision 0081). */
@OptIn(ExperimentalCoroutinesApi::class)
class PendingResponsesTest {
    private class Files : OfflineFiles {
        val map = HashMap<String, JsonElement>()
        override fun load(computerId: String, name: String) = map["$computerId/$name"]
        override fun save(computerId: String, name: String, value: JsonElement) { map["$computerId/$name"] = value }
        override fun remove(computerId: String) { map.keys.removeAll { it.startsWith("$computerId/") } }
    }

    private val question = AskRequest(
        "ask-1",
        listOf(AskQuestion("q1", "Database", "Which one?", listOf(AskOption("Postgres", "Relational"), AskOption("SQLite", null)), false)),
        askedAt = 1000,
    )
    private val approval = Approval(ToolCall("call-1", "shell", buildJsonObject { put("command", "ls") }), "Lists files", Severity.MEDIUM)

    private fun pendingJson(sid: String, q: AskRequest? = null, a: Approval? = null) = buildJsonObject {
        put(sid, buildJsonObject {
            q?.let { r ->
                put("question", buildJsonObject {
                    put("callId", r.callId); put("askedAt", r.askedAt)
                    put("questions", buildJsonArray {
                        r.questions.forEach { x ->
                            add(buildJsonObject {
                                put("id", x.id); put("header", x.header); put("question", x.question); put("multiSelect", x.multiSelect)
                                put("options", buildJsonArray { x.options.forEach { o -> add(buildJsonObject { put("label", o.label); o.description?.let { put("description", it) } }) } })
                            })
                        }
                    })
                })
            }
            a?.let { ap ->
                put("approval", buildJsonObject {
                    put("call", buildJsonObject { put("id", ap.call.id); put("name", ap.call.name); put("input", ap.call.input) })
                    put("reason", ap.reason); put("severity", ap.severity.name.lowercase())
                })
            }
        })
    }

    private var online = true
    private var pending: JsonElement = JsonObject(emptyMap())
    private val caller = FakeCaller { c -> if (c.channel == Channels.CHAT_PENDING) pending else JsonNull }
    private val files = Files()
    private var n = 0
    private fun queue() = PendingResponses(files, { caller.takeIf { online } }, { "m${++n}" }).also { it.load("pc") }

    private fun sends() = caller.calls.filter { it.channel == Channels.CHAT_ANSWER || it.channel == Channels.TOOL_APPROVE }

    @Test fun offlineAnswerWaitsSurvivesRestartAndGoesWhenTheSameQuestionStillWaits() = runTest {
        online = false
        val q = queue()
        q.answer("s1", question, listOf(AskAnswer("q1", listOf("Postgres"), "with pgvector")))
        q.flush()
        assertEquals(Status.WAITING, q.items.value.single().status)
        assertEquals("Database: Postgres, with pgvector", q.items.value.single().text)
        assertEquals("answer:ask-1", q.items.value.single().pendingId)
        assertTrue(q.contains("s1", question))

        // The app closes and opens again: the message is still there.
        val again = queue()
        assertEquals(1, again.items.value.size)
        online = true
        pending = pendingJson("s1", q = question)
        again.flush()
        assertEquals(Status.SENT, again.items.value.single().status)
        val sent = sends().single()
        assertEquals(Channels.CHAT_ANSWER, sent.channel)
        assertEquals(listOf("s1", "ask-1"), sent.args.take(2).map { it.jsonPrimitive.content })
        assertEquals(JsonArray(listOf(AskAnswer("q1", listOf("Postgres"), "with pgvector").toJson())), sent.args[2])
    }

    @Test fun aReplacedOrAnsweredRequestIsNoLongerPendingAndNothingIsSent() = runTest {
        val q = queue()
        online = false
        q.approve("s1", approval, ok = true)
        q.answer("s1", question, listOf(AskAnswer("q1", listOf("SQLite"))))
        online = true
        // The approval now asks about a different command; the question was answered on the computer.
        pending = pendingJson("s1", a = approval.copy(call = approval.call.copy(input = buildJsonObject { put("command", "rm -rf /") })))
        q.flush()
        assertEquals(listOf(Status.STALE, Status.STALE), q.items.value.map { it.status })
        assertEquals(PendingResponses.STALE, q.items.value.first().error)
        assertTrue(sends().isEmpty())
        // A stale one is never retried by a later flush either.
        pending = pendingJson("s1", q = question, a = approval)
        q.flush()
        assertTrue(sends().isEmpty())
    }

    @Test fun anApprovalGoesAsAllowOrDenyForThatCall() = runTest {
        val q = queue()
        online = false
        q.approve("s1", approval, ok = false)
        assertEquals("Deny shell", q.items.value.single().text)
        online = true
        pending = pendingJson("s1", a = approval)
        q.flush()
        val sent = sends().single()
        assertEquals(Channels.TOOL_APPROVE, sent.channel)
        assertEquals(listOf(JsonPrimitive("s1"), JsonPrimitive("call-1"), JsonPrimitive(false)), sent.args)
    }

    @Test fun anUnreadablePendingListFailsWithoutSending() = runTest {
        val q = queue()
        q.approve("s1", approval, ok = true)
        pending = JsonArray(emptyList())
        q.flush()
        assertEquals(Status.FAILED, q.items.value.single().status)
        assertEquals("Could not verify the original request.", q.items.value.single().error)
        assertTrue(sends().isEmpty())
    }

    @Test fun aLostAcknowledgementFindsNothingPendingOnRetry() = runTest {
        val q = queue()
        pending = pendingJson("s1", a = approval)
        caller.handler = { c ->
            when (c.channel) {
                Channels.CHAT_PENDING -> pending
                // It reached the computer, but the reply didn't come back.
                else -> { pending = JsonObject(emptyMap()); throw RelayException("tool:approve: timed out", afterSend = true) }
            }
        }
        q.approve("s1", approval, ok = true)
        q.flush()
        assertEquals(Status.FAILED, q.items.value.single().status)
        assertEquals(1, sends().size)
        assertTrue(q.retry(q.items.value.single().id))
        q.flush()
        assertEquals(Status.STALE, q.items.value.single().status)
        assertEquals(1, sends().size)
    }

    @Test fun aSecondTapAddsNothingAndCancelRemovesOnlyUnsent() = runTest {
        val q = queue()
        online = false
        q.approve("s1", approval, ok = true)
        q.approve("s1", approval, ok = false)
        assertEquals(1, q.items.value.size)
        q.cancel(q.items.value.single().id)
        assertTrue(q.items.value.isEmpty())
        assertTrue(queue().items.value.isEmpty())
    }

    @Test fun oneSendAtATimeAndTheOneBeingSentCannotBeCancelled() = runTest {
        val q = queue()
        pending = pendingJson("s1", a = approval)
        val gate = CompletableDeferred<Unit>()
        caller.handler = { c -> if (c.channel == Channels.CHAT_PENDING) { gate.await(); pending } else JsonNull }
        q.approve("s1", approval, ok = true)
        val first = launch { q.flush() }
        runCurrent()
        assertEquals(Status.SENDING, q.items.value.single().status)
        assertFalse(q.items.value.single().actionable)
        launch { q.flush() }
        runCurrent()
        q.cancel(q.items.value.single().id)
        assertEquals(1, q.items.value.size)
        assertEquals(1, caller.calls.count { it.channel == Channels.CHAT_PENDING })
        gate.complete(Unit)
        first.join()
        runCurrent()
        assertEquals(Status.SENT, q.items.value.single().status)
        assertEquals(1, sends().size)
    }

    @Test fun switchingComputerStopsTheSendAndShowsTheOtherQueue() = runTest {
        val q = queue()
        pending = pendingJson("s1", a = approval)
        val gate = CompletableDeferred<Unit>()
        caller.handler = { c -> if (c.channel == Channels.CHAT_PENDING) { gate.await(); pending } else JsonNull }
        q.approve("s1", approval, ok = true)
        val job = launch { q.flush() }
        runCurrent()
        q.load("other")
        assertTrue(q.items.value.isEmpty())
        gate.complete(Unit)
        job.join()
        assertTrue(sends().isEmpty())
        // Back on the first computer the message waits again, not lost and not marked sent.
        q.load("pc")
        assertEquals(Status.WAITING, q.items.value.single().status)
    }

    @Test fun nothingIsKeptWithoutAComputer() {
        val q = PendingResponses(files, { null })
        q.load(null)
        q.approve("s1", approval, ok = true)
        assertTrue(q.items.value.isEmpty())
    }

    @Test fun aSavedMessageThatWasSendingComesBackWaiting() {
        val m = ResponseMessage("m", "s1", "call-1", ResponseMessage.Kind.APPROVAL, ResponseMessage.request(approval), JsonPrimitive(true), "Allow shell", Status.SENDING)
        assertEquals(Status.WAITING, ResponseMessage.from(m.json())!!.status)
    }
}
