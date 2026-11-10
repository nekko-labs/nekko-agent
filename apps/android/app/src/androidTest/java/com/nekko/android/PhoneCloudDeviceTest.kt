package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.AndroidSecureStore
import com.nekko.android.data.SecureStore
import com.nekko.android.phone.*
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.PhoneRequest
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real Compose controls, no network or paired computer, synthetic device-only records. */
class PhoneCloudDeviceTest {
    private val compose = createAndroidComposeRule<ComponentActivity>()
    private val publisher = androidx.window.testing.layout.WindowLayoutInfoPublisherRule()
    @get:Rule val rules: org.junit.rules.RuleChain = org.junit.rules.RuleChain.outerRule(publisher).around(compose)
    private val dark = InstrumentationRegistry.getArguments().getString("nekkoTheme") == "dark"
    @org.junit.After fun cleanup() { scope.cancel() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private class Memory : SecureStore {
        val map = mutableMapOf<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }
    private class ScopedDeviceStore : SecureStore {
        private val context = ApplicationProvider.getApplicationContext<NekkoApp>()
        private val store = AndroidSecureStore(context)
        private val prefix = "native-cloud-test-" + UUID.randomUUID() + ":"
        private val keys = mutableSetOf<String>()
        override suspend fun get(key: String) = store.get(prefix + key)
        override suspend fun set(key: String, value: String?) { keys += key; store.set(prefix + key, value) }
        suspend fun clear() { keys.forEach { store.set(prefix + it, null) } }
    }
    private class HTTP : PhoneHTTP {
        var hold = false
        val requests = mutableListOf<PhoneRequest>()
        override suspend fun send(request: PhoneRequest, line: ((String) -> Boolean)?): String {
            requests += request
            if (line == null) return """{"data":[{"id":"test-chat-model","name":"Test chat model"}]}"""
            line("data: {\"choices\":[{\"delta\":{\"content\":\"A reply directly on this phone.\"}}]}"); line("")
            if (hold) awaitCancellation()
            line("data: [DONE]"); line(""); return ""
        }
    }
    @Test fun setupTestNewKeyDisableRemoveJourney() {
        val memory = Memory(); val http = HTTP(); val phone = PhoneChats(memory, http, scope)
        runBlocking { phone.load() }
        compose.setContent { NekkoTheme(dark = dark) { PhoneScreen(phone) {} } }
        compose.onNodeWithTag("phone.providers").performClick()
        compose.onNodeWithTag("phone.add").performClick()
        shot("add-provider")
        compose.onNodeWithTag("phone.key").performTextInput("synthetic-device-key")
        compose.onNodeWithTag("phone.save").performClick()
        compose.waitUntil(5000) { phone.state.value.providers.size == 1 }
        compose.onNodeWithText("Test", useUnmergedTree = true).performClick()
        compose.waitUntil(5000) { http.requests.isNotEmpty() }
        compose.onNodeWithText("Connection works.").assertExists()
        compose.onNodeWithText("Dismiss").performClick()
        compose.onNodeWithText("New key").performClick()
        compose.onNodeWithTag("phone.newKey").performTextInput("replacement-key")
        compose.onNodeWithText("Save key").performClick()
        compose.waitUntil(5000) { memory.map.values.contains("replacement-key") }
        val p = phone.state.value.providers.single()
        compose.onNodeWithTag("phone.enable.${p.id}").performClick()
        compose.waitUntil(5000) { !phone.state.value.providers.single().enabled }
        shot("disabled-provider")
        compose.onNodeWithText("Remove", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Remove provider").performClick()
        compose.waitUntil(5000) { phone.state.value.providers.isEmpty() }
        assertFalse(memory.map.containsKey("phone.provider.key.${p.id}"))
        scope.cancel()
    }
    @Test fun standaloneStreamStopRetryPersistForgetJourney() {
        val memory = ScopedDeviceStore(); val http = HTTP(); val phone = PhoneChats(memory, http, scope)
        runBlocking { phone.load(); phone.add("openai", "Personal API", null, "synthetic") }
        compose.setContent { NekkoTheme(dark = dark) { PhoneScreen(phone) {} } }
        compose.onNodeWithTag("phone.new").performClick()
        compose.waitUntil(5000) { phone.state.value.models.isNotEmpty() }
        compose.onNodeWithTag("phone.model.test-chat-model").performClick()
        compose.waitUntil(5000) { phone.state.value.chats.size == 1 }
        http.hold = true
        compose.onNodeWithTag("phone.message").performTextInput("Hello from an unpaired phone")
        compose.onNodeWithTag("phone.send").performClick()
        compose.waitUntil(5000) { phone.state.value.running.isNotEmpty() }
        // Exercise native touch dispatch, not an accessibility-only shortcut.
        compose.waitForIdle()
        compose.onNodeWithTag("phone.stop").assertIsDisplayed().performClick()
        compose.waitUntil(5000) { phone.state.value.running.isEmpty() }
        http.hold = false
        compose.onNodeWithTag("phone.retry").performClick()
        compose.waitUntil(5000) { http.requests.count { it.body != null } == 2 && phone.state.value.running.isEmpty() }
        compose.onNodeWithText("A reply directly on this phone.", substring = true).assertExists()
        shot("standalone-chat", "phone.transcript", "phone.message")
        val restored = PhoneChats(memory, http, scope)
        runBlocking { restored.load() }
        assertEquals(phone.state.value.chats, restored.state.value.chats)
        assertEquals(2, phone.state.value.chats.single().messages.size)
        compose.onNodeWithText("Forget", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Forget chat").performClick()
        compose.waitUntil(5000) { phone.state.value.chats.isEmpty() }
        runBlocking { memory.clear() }
        scope.cancel()
    }
    @Test fun phoneEntryVisibleBeforePairingAndProviderSetup() {
        val app = ApplicationProvider.getApplicationContext<NekkoApp>()
        // ComponentActivity has no MainActivity authentication flow; initialize its unlocked fixture explicitly.
        runBlocking { app.phoneChats.load() }
        val prefs = com.nekko.android.data.PhonePrefs(object : com.nekko.android.data.PrefStore {
            private val values = mutableMapOf<String, String>()
            override fun getString(name: String) = values[name]
            override fun putString(name: String, value: String?) { if (value == null) values.remove(name) else values[name] = value }
        })
        compose.setContent { NekkoTheme(dark = dark) {
            com.nekko.android.ui.NekkoNavHost(app.computers, app.themePrefs, prefs, com.nekko.android.share.ShareInbox(), incomingLink = kotlinx.coroutines.flow.MutableStateFlow(null), onLinkHandled = {})
        } }
        compose.onNodeWithText("This phone").assertIsDisplayed()
        shot("first-run-entry")
        compose.onNodeWithText("This phone").performClick()
        compose.onNodeWithTag("phone.providers").assertIsDisplayed()
        shot("empty-phone")
    }
    @Test fun bookAndTabletopRespectHinge() {
        val bounds = androidx.window.layout.WindowMetricsCalculator.getOrCreate().computeCurrentWindowMetrics(compose.activity).bounds
        val density = compose.activity.resources.displayMetrics.density
        org.junit.Assume.assumeTrue("expanded emulator required", bounds.width() / density >= 600f)
        val http = HTTP(); val phone = PhoneChats(Memory(), http, scope)
        val id = runBlocking { phone.load(); val p = phone.add("openai", "Personal API", null, "synthetic"); phone.models(p); phone.newChat(p, "test-chat-model") }
        compose.setContent { NekkoTheme(dark = dark) { PhoneScreen(phone) {} } }
        phone.send(id, "Fold transition content")
        compose.onNodeWithTag("phone.open.$id").performClick()
        fun contentVisible(expanded: Boolean) {
            var failure: Throwable? = null
            try {
                compose.waitUntil(5000) {
                    runCatching {
                        compose.onNodeWithTag("phone.conversation").assertIsDisplayed()
                        compose.onNodeWithTag("phone.message").assertIsDisplayed()
                        compose.onNodeWithTag("phone.send").assertIsDisplayed()
                        compose.onAllNodes(hasText("Fold transition content") and hasAnyAncestor(hasTestTag("phone.conversation"))).onLast().assertIsDisplayed()
                        compose.onNodeWithText("A reply directly on this phone.").assertIsDisplayed()
                        if (expanded) {
                            compose.onNodeWithTag("phone.chatList").assertIsDisplayed()
                            compose.onNodeWithTag("phone.new").assertIsDisplayed()
                        }
                    }.onFailure { failure = it }.isSuccess
                }
            } catch (e: androidx.compose.ui.test.ComposeTimeoutException) {
                throw AssertionError("Visible content missing (expanded=$expanded): ${compose.onRoot(useUnmergedTree = true).printToString()}", failure ?: e)
            }
        }
        contentVisible(expanded = true)
        shot("fold-before", "phone.chatList", "phone.transcript", "phone.message")
        fun stableShot(name: String, expanded: Boolean) {
            contentVisible(expanded)
            shot(name, *if (expanded) arrayOf("phone.chatList", "phone.transcript", "phone.message") else arrayOf("phone.transcript", "phone.message"))
        }
        val book = androidx.window.testing.layout.FoldingFeature(compose.activity, state = androidx.window.layout.FoldingFeature.State.HALF_OPENED, orientation = androidx.window.layout.FoldingFeature.Orientation.VERTICAL, size = (24 * density).toInt())
        compose.runOnUiThread { publisher.overrideWindowLayoutInfo(androidx.window.testing.layout.TestWindowLayoutInfo(listOf(book))) }
        compose.waitForIdle()
        val message = compose.onNodeWithTag("phone.message").fetchSemanticsNode().boundsInWindow
        assertTrue("composer after vertical gap", message.left >= book.bounds.right)
        stableShot("book", expanded = true)
        val tabletop = androidx.window.testing.layout.FoldingFeature(compose.activity, state = androidx.window.layout.FoldingFeature.State.HALF_OPENED, orientation = androidx.window.layout.FoldingFeature.Orientation.HORIZONTAL)
        compose.runOnUiThread { publisher.overrideWindowLayoutInfo(androidx.window.testing.layout.TestWindowLayoutInfo(listOf(tabletop))) }
        compose.waitForIdle()
        val box = compose.onNodeWithTag("phone.message").fetchSemanticsNode().boundsInWindow
        assertTrue("composer below horizontal hinge", box.top >= tabletop.bounds.bottom)
        stableShot("tabletop", expanded = false)
        val flat = androidx.window.testing.layout.FoldingFeature(compose.activity, state = androidx.window.layout.FoldingFeature.State.FLAT, orientation = androidx.window.layout.FoldingFeature.Orientation.HORIZONTAL)
        compose.runOnUiThread { publisher.overrideWindowLayoutInfo(androidx.window.testing.layout.TestWindowLayoutInfo(listOf(flat))) }
        compose.waitForIdle()
        compose.onNodeWithTag("phone.expanded").assertIsDisplayed()
        stableShot("unfolded", expanded = true)
        val verticalFlat = androidx.window.testing.layout.FoldingFeature(compose.activity, state = androidx.window.layout.FoldingFeature.State.FLAT, orientation = androidx.window.layout.FoldingFeature.Orientation.VERTICAL)
        compose.runOnUiThread { publisher.overrideWindowLayoutInfo(androidx.window.testing.layout.TestWindowLayoutInfo(listOf(verticalFlat))) }
        compose.waitForIdle()
        stableShot("vertical-flat", expanded = true)
        compose.runOnUiThread { publisher.overrideWindowLayoutInfo(androidx.window.testing.layout.TestWindowLayoutInfo(emptyList())) }
        compose.waitForIdle()
        stableShot("no-hinge", expanded = true)
        scope.cancel()
    }
    @Test fun keystoreSealsCredentialAndDeletionSurvivesReopen() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<NekkoApp>()
        val name = "phone-test-${UUID.randomUUID()}"
        val secret = "synthetic-keystore-secret"
        val store = AndroidSecureStore(context)
        try {
            store.set(name, secret)
            assertEquals(secret, AndroidSecureStore(context).get(name))
            val prefs = context.getSharedPreferences("nekko_secure", 0)
            assertFalse(prefs.getString(name, "")!!.contains(secret))
            store.set(name, null)
            assertNull(AndroidSecureStore(context).get(name))
        } finally { store.set(name, null) }
    }
    private fun shot(name: String, vararg visibleTags: String) {
        compose.waitForIdle()
        visibleTags.forEach { compose.onNodeWithTag(it).assertIsDisplayed() }
        // Semantics may settle before the system screenshot presents the new frame.
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        Thread.sleep(300)
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: "phone"
        val file = File(compose.activity.getExternalFilesDir(null), "evidence/cloud-2414/$device-$name.png")
        file.parentFile!!.mkdirs()
        instrumentation.uiAutomation.takeScreenshot().use { bitmap ->
            visibleTags.forEach { tag ->
                val bounds = compose.onNodeWithTag(tag).assertIsDisplayed().fetchSemanticsNode().boundsInWindow
                val left = bounds.left.toInt().coerceIn(0, bitmap.width - 1)
                val top = bounds.top.toInt().coerceIn(0, bitmap.height - 1)
                val right = bounds.right.toInt().coerceIn(left + 1, bitmap.width)
                val bottom = bounds.bottom.toInt().coerceIn(top + 1, bitmap.height)
                val background = bitmap.getPixel(left, top)
                var ink = 0
                for (y in top until bottom) for (x in left until right) {
                    if (bitmap.getPixel(x, y) != background) ink++
                }
                assertTrue("$name: $tag screenshot region must contain rendered content, not blank pixels", ink > 100)
            }
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}

private inline fun <T> Bitmap.use(block: (Bitmap) -> T): T = try { block(this) } finally { recycle() }
