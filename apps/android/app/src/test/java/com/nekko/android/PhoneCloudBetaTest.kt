package com.nekko.android

import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.SecureStore
import com.nekko.android.phone.PhoneChats
import com.nekko.android.phone.PhoneCloudBeta
import com.nekko.android.phone.PhoneHTTP
import com.nekko.protocol.PhoneRequest
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Settings → Beta → cloud models on this phone: off for a new install, kept for one that used it. */
@OptIn(ExperimentalCoroutinesApi::class)
class PhoneCloudBetaTest {
    private class Memory : SecureStore {
        val values = mutableMapOf<String, String>()
        override suspend fun get(key: String) = values[key]
        override suspend fun set(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }
    private class HTTP : PhoneHTTP {
        var hold = false
        var sent = 0
        override suspend fun send(request: PhoneRequest, line: ((String) -> Boolean)?): String {
            if (line == null) return """{"data":[{"id":"chat-model","name":"Chat model"}]}"""
            sent++
            line("data: {\"choices\":[{\"delta\":{\"content\":\"Part\"}}]}"); line("")
            if (hold) awaitCancellation()
            line("data: [DONE]"); line("")
            return ""
        }
    }

    @Test fun aNewInstallStartsOffAndStaysUndecided() = runTest {
        val prefs = PhonePrefs(MapPrefStore())
        val phone = PhoneChats(Memory(), HTTP(), backgroundScope)
        PhoneCloudBeta.atLaunch(prefs, phone)
        phone.load()
        PhoneCloudBeta.afterLoad(prefs, phone)
        assertFalse(phone.state.value.available)
        assertNull(prefs.get(PhoneCloudBeta.KEY))
    }

    @Test fun aPhoneThatUsedItKeepsItForGood() = runTest {
        val memory = Memory()
        PhoneChats(memory, HTTP(), backgroundScope).apply { load(); add("openai", "My API", null, "k") }
        val prefs = PhonePrefs(MapPrefStore())
        val phone = PhoneChats(memory, HTTP(), backgroundScope)
        PhoneCloudBeta.atLaunch(prefs, phone)
        assertFalse("off until the store has loaded", phone.state.value.available)
        phone.load()
        PhoneCloudBeta.afterLoad(prefs, phone)
        assertTrue(phone.state.value.available)
        assertEquals(true, prefs.get(PhoneCloudBeta.KEY))
    }

    @Test fun theUsersChoiceWins() = runTest {
        val memory = Memory()
        PhoneChats(memory, HTTP(), backgroundScope).apply { load(); add("openai", "My API", null, "k") }
        val prefs = PhonePrefs(MapPrefStore())
        prefs.set(PhoneCloudBeta.KEY, false)
        val phone = PhoneChats(memory, HTTP(), backgroundScope)
        PhoneCloudBeta.atLaunch(prefs, phone)
        phone.load()
        PhoneCloudBeta.afterLoad(prefs, phone)
        assertFalse(phone.state.value.available)
    }

    @Test fun offStopsAReplySendsNothingAndKeepsTheChat() = runTest {
        val http = HTTP()
        val prefs = PhonePrefs(MapPrefStore())
        val phone = PhoneChats(Memory(), http, backgroundScope)
        phone.load()
        // Adding checks the key with a reply of its own, so the hold starts after it.
        val p = phone.add("openai", "My API", null, "k")
        phone.test(p)
        val id = phone.newChat(p, "chat-model")
        http.hold = true
        val before = http.sent
        phone.send(id, "Hi"); runCurrent()
        assertEquals(setOf(id), phone.state.value.running)
        PhoneCloudBeta.set(prefs, phone, false); runCurrent()
        assertTrue(phone.state.value.running.isEmpty())
        assertEquals("Stopped.", phone.state.value.chats.single().messages.last().error)
        phone.send(id, "Again"); runCurrent()
        assertEquals("nothing sent while off", before + 1, http.sent)
        try { phone.newChat(p, "chat-model"); fail("no new chat while off") } catch (_: IllegalStateException) { }
        assertEquals(1, phone.state.value.chats.size)
        assertEquals(1, phone.state.value.providers.size)
        PhoneCloudBeta.set(prefs, phone, true)
        assertTrue(phone.state.value.available)
        assertEquals(true, prefs.get(PhoneCloudBeta.KEY))
    }
}
