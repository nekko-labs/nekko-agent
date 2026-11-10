package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.CompositionLocalProvider
import com.nekko.android.ui.simple.LocalSimple
import com.nekko.android.ui.simple.rememberSimpleView
import com.nekko.android.ui.screens.ChatsScreen
import com.nekko.android.ui.settings.SimpleModeScreen
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.monitors.EXPERT_MODE
import com.nekko.android.ui.chat.ModeTags
import com.nekko.android.ui.simple.PILL_TAB_TAG
import com.nekko.android.ui.simple.PILL_TAG
import com.nekko.android.data.PillDock
import com.nekko.android.data.PillPlace
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import com.nekko.android.ui.panes.PaneLabels
import com.nekko.android.ui.panes.PanesHost
import com.nekko.android.ui.panes.rememberWindowPosture
import com.nekko.android.ui.screens.ChatScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.PaneContent
import com.nekko.protocol.PaneLayout
import com.nekko.protocol.PaneMode
import com.nekko.protocol.PaneSide
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.WelcomedDevice
import com.nekko.protocol.WireJson
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

private const val EXPERT_DESCRIPTION = "Detailed: every control"

/**
 * Simple and Expert modes in the real chat screen (spec/phone/iphone-simple-and-expert-modes.md):
 * [ChatScreen] and [ChatViewModel] over a real [ComputersRepository] whose computer is a fake
 * answering like the phone gate does. On an open folding phone (600 dp or wider) it shows two
 * chats side by side in [PanesHost], as the app does; on a phone, one chat. Each step is a
 * whole-screen screenshot (sheets and menus included) under the app's external files
 * (`evidence/`), named by device.
 */
@RunWith(AndroidJUnit4::class)
class ChatModesTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val computer = FakeComputer()

    // Only the manual evidence workflow reads the selected app revision's label. Normal
    // test runs keep the explicit current-label selector above, including rename regressions.
    private val expertDescription: String
        get() = if (InstrumentationRegistry.getArguments().getString("nekkoModeEvidence") == "true") {
            InstrumentationRegistry.getInstrumentation().targetContext.getString(R.string.simple_switch_expert)
        } else EXPERT_DESCRIPTION

    /** What Start fresh asked New chat to open on. */
    @Volatile private var fresh: com.nekko.android.data.ModelPick? = null

    /** Names the screenshots: `-e nekkoDevice fold`, else the model (every emulator calls itself the same). */
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private val prefs = PhonePrefs(object : PrefStore {
        val map = HashMap<String, String>()
        override fun getString(name: String) = map[name]
        override fun putString(name: String, value: String?) { if (value == null) map.remove(name) else map[name] = value }
    })

    @Test fun simpleAndExpert() {
        show()
        // Simple with a local model loaded: the context ring, and the minimal monitor in the mode pill.
        compose.waitUntil(15_000) { computer.calls.contains(Channels.SYSTEM_STATS) }
        settle()
        assertTrue(compose.onAllNodesWithTag(ModeTags.MODEL_EFFORT).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodesWithTag(ModeTags.CONTEXT).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodesWithTag(ModeTags.MONITOR).fetchSemanticsNodes().isNotEmpty())
        shot("1-simple-local-model")

        // A tap on a gauge opens the pill into the agent's details.
        compose.onAllNodesWithContentDescription("CPU, 38%").onFirst().performClick()
        settle()
        assertTrue(compose.onAllNodesWithTag(ModeTags.MONITOR_SHEET).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasText("16 cores", substring = true)).fetchSemanticsNodes().isNotEmpty())
        shot("2-panel")
        compose.onAllNodes(hasText("Unload")).onFirst().performClick()
        compose.waitUntil(5_000) { computer.calls.contains(Channels.MODEL_UNLOAD) }
        settle()
        // No local model now: Simple drops the monitor and stops the hardware reads.
        assertEquals(0, compose.onAllNodesWithTag(ModeTags.MONITOR).fetchSemanticsNodes().size)
        shot("3-simple-unloaded")
        val idle = computer.calls.count { it == Channels.SYSTEM_STATS }
        Thread.sleep(4_000)
        assertEquals("Simple without a local model reads no hardware", idle, computer.calls.count { it == Channels.SYSTEM_STATS })

        // Expert (the code icon) with no local model: the monitors are off in both modes until a
        // local model runs (spec/phone/iphone-simple-and-expert-modes.md, "Monitors"), so still no
        // monitor and no hardware reads. Expert with a local model shows them: pillExpandsAndDocks.
        chooseMode(expert = true)
        assertTrue(prefs.get(EXPERT_MODE))
        Thread.sleep(4_000)
        assertEquals("Expert without a local model reads no hardware either", idle, computer.calls.count { it == Channels.SYSTEM_STATS })
        assertEquals(0, compose.onAllNodesWithTag(ModeTags.MONITOR).fetchSemanticsNodes().size)
        shot("4-expert")

        // Model and effort: the sheet with the effort slider, then High.
        compose.onAllNodesWithTag(ModeTags.MODEL_EFFORT).onFirst().performClick()
        settle()
        shot("5-model-effort")
        compose.onAllNodesWithTag(ModeTags.effort(com.nekko.protocol.Effort.HIGH)).onFirst().performClick()
        compose.waitUntil(5_000) { computer.effort == "high" }
        settle()
        shot("6-effort-high")
        Espresso.pressBack()
        settle()

        // The context ring's breakdown.
        compose.onAllNodesWithTag(ModeTags.CONTEXT).onFirst().performClick()
        settle()
        shot("7-context")
        Espresso.pressBack()
        settle()

        // Back to Simple: no monitor, and no more hardware reads.
        chooseMode(expert = false)
        val reads = computer.calls.count { it == Channels.SYSTEM_STATS }
        Thread.sleep(4_000)
        assertEquals("Simple stops the hardware reads", reads, computer.calls.count { it == Channels.SYSTEM_STATS })
        assertEquals(0, compose.onAllNodesWithTag(ModeTags.MONITOR).fetchSemanticsNodes().size)
    }

    /**
     * The chats list in Simple with no local model: no gauges, so no pill at all (#2117); Simple /
     * Detailed is the first section of the view menu, a check on the current mode.
     */
    @Test fun chatsListInSimple() {
        computer.resident = false
        val repo = repo()
        // What the app does at start: read the paired computers, which marks the list ready.
        runBlocking { repo.load() }
        compose.setContent {
            NekkoTheme(dark = false) {
                CompositionLocalProvider(LocalSimple provides rememberSimpleView(prefs)) {
                    ChatsScreen(repo, onOpenChat = {}, onNewChat = {}, onPair = {}, onComputers = {}, onSettings = {}, onMonitors = {})
                }
            }
        }
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Tidy the release notes")).fetchSemanticsNodes().isNotEmpty() }
        settle()
        shot("chats-simple")
        assertEquals(0, compose.onAllNodesWithTag(PILL_TAG).fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithTag(ModeTags.MONITOR).fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodes(hasText("Monitors")).fetchSemanticsNodes().size)
        compose.onAllNodesWithTag("chats.view").onFirst().performClick()
        settle()
        compose.onNodeWithTag("menu.mode.simple").assertIsSelected()
        compose.onNodeWithTag("menu.mode.detailed").assertIsNotSelected()
        shot("chats-view-menu-mode")
        compose.onNodeWithTag("menu.mode.detailed").performClick()
        settle()
        assertTrue(prefs.get(EXPERT_MODE))
    }

    /**
     * A chat in Simple: the turn's steps on one line that opens in place, then a local model
     * loading brings the minimal monitor into the pill, and it opens the details. The monitor and
     * the menu's Detailed take touches over 48 dp.
     */
    @Test fun simpleChatStepsAndLocalModel() {
        computer.resident = false
        show()
        assertEquals(0, compose.onAllNodesWithTag(ModeTags.MONITOR).fetchSemanticsNodes().size)
        assertTrue(compose.onAllNodes(hasText("Took 3 steps · 14s")).fetchSemanticsNodes().isNotEmpty())
        assertEquals(0, compose.onAllNodes(hasText("Show reasoning")).fetchSemanticsNodes().size)
        shot("chat-simple-steps-folded")

        compose.onAllNodes(hasText("Show steps")).onFirst().performClick()
        settle()
        shot("chat-simple-steps-shown")
        assertTrue(compose.onAllNodes(hasText("Show reasoning")).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasText("Hide steps")).fetchSemanticsNodes().isNotEmpty())
        compose.onAllNodes(hasText("Hide steps")).onFirst().performClick()
        settle()

        // A model loads on the computer: Simple's 10 s check brings the monitor in.
        computer.resident = true
        compose.waitUntil(15_000) { compose.onAllNodesWithTag(ModeTags.MONITOR).fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(10_000) { computer.calls.contains(Channels.SYSTEM_STATS) }
        settle()
        shot("chat-simple-local-model")

        val min = with(compose.density) { 48.dp.toPx() } - 1
        assertTrue(compose.onAllNodesWithTag(ModeTags.MONITOR).onFirst().fetchSemanticsNode().boundsInRoot.height >= min)
        compose.onAllNodesWithTag(ModeTags.MONITOR).onFirst().performClick()
        settle()
        assertTrue(compose.onAllNodesWithTag(ModeTags.MONITOR_SHEET).fetchSemanticsNodes().isNotEmpty())
        shot("chat-panel")
        Espresso.pressBack()
        settle()
        assertEquals(0, compose.onAllNodesWithTag(ModeTags.MONITOR_SHEET).fetchSemanticsNodes().size)

        // The pill holds only the gauges now: Detailed is in the chat's ⋮ menu, a 48 dp row.
        assertEquals(0, compose.onAllNodesWithContentDescription(expertDescription).fetchSemanticsNodes().size)
        compose.onAllNodesWithTag("chat.more").onFirst().performClick()
        settle()
        assertTrue(compose.onNodeWithTag("menu.mode.detailed").fetchSemanticsNode().boundsInRoot.height >= min)
        compose.onNodeWithTag("menu.mode.detailed").performClick()
        settle()
        assertTrue(prefs.get(EXPERT_MODE))
    }

    /**
     * #2112: a finished reply's metrics under it, with the check for a turn that completed, and its
     * breakdown on a tap, in Simple (steps folded) and Detailed.
     */
    @Test fun turnMetricsAndDetails() {
        computer.resident = false
        computer.turnStats = true
        show()
        val footer = compose.onAllNodesWithTag("turn.details.s1-a").onFirst()
        footer.assertExists()
        compose.onAllNodes(hasText("Done")).onFirst().assertExists()
        // TalkBack reads the line as one label.
        compose.onAllNodes(androidx.compose.ui.test.hasContentDescription("Done. claude-opus-4-7, anthropic, High effort, 12k in, 612 out, 75 tok/s, 14s")).onFirst().assertExists()
        shot("turn-metrics")
        footer.performClick()
        settle()
        // The row is one button for TalkBack, so the breakdown is inside its merged node.
        compose.onAllNodesWithTag("turn.breakdown", useUnmergedTree = true).onFirst().assertExists()
        compose.onAllNodes(hasText("Read from cache"), useUnmergedTree = true).onFirst().assertExists()
        compose.onAllNodes(hasText("Finished"), useUnmergedTree = true).onFirst().assertExists()
        shot("turn-details")
        footer.performClick()
        settle()
        assertEquals(0, compose.onAllNodesWithTag("turn.breakdown", useUnmergedTree = true).fetchSemanticsNodes().size)
        // Detailed shows the same line, once.
        chooseMode(expert = true)
        assertEquals(1, compose.onAllNodesWithTag("turn.details.s1-a").fetchSemanticsNodes().size)
        computer.turnStats = false
    }

    /**
     * #2117: Nekko beside the chat's title says hello on a tap, offers Refresh to TalkBack, and
     * a pull up past the newest message reads the chat again from the computer.
     */
    @Test fun titleMascotAndPullUpRefresh() {
        computer.resident = false
        show()
        val mascot = compose.onAllNodesWithTag("chat.mascot").onFirst()
        mascot.assertExists()
        shot("chat-title-mascot")
        mascot.performClick()
        compose.onAllNodesWithTag("chat.mascot").onFirst().assert(androidx.compose.ui.test.SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.StateDescription, "Hello!"))

        // Pull up past the newest message: one more session:get.
        val before = computer.calls.count { it == Channels.SESSION_GET }
        repeat(2) { compose.onRoot().performTouchInput { swipeUp(startY = height * 0.7f, endY = height * 0.2f, durationMillis = 400) } }
        compose.waitUntil(10_000) { computer.calls.count { it == Channels.SESSION_GET } > before }
        settle()
        shot("chat-after-pull-up")

        // The mascot's Refresh action does the same.
        val again = computer.calls.count { it == Channels.SESSION_GET }
        val actions = compose.onAllNodesWithTag("chat.mascot").onFirst().fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsActions.CustomActions]
        compose.runOnIdle { actions.single { it.label == "Refresh" }.action() }
        compose.waitUntil(10_000) { computer.calls.count { it == Channels.SESSION_GET } > again }

        // Evidence: the finger held past the end shows the spinner rising; let go, it turns while the chat reloads.
        computer.slowGet = 2_500
        compose.onRoot().performTouchInput {
            down(Offset(centerX, height * 0.7f))
            repeat(20) { moveBy(Offset(0f, -30f)); advanceEventTime(16) }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("chat.pullUpRefresh").assertExists()
        shot("chat-pulling-up")
        compose.onRoot().performTouchInput { up() }
        compose.waitForIdle()
        compose.onNodeWithTag("chat.pullUpRefresh").assertExists()
        shot("chat-refreshing")
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("chat.pullUpRefresh").fetchSemanticsNodes().isEmpty() }
        computer.slowGet = 0

        // Simple / Detailed is the ⋮ menu's first section.
        compose.onAllNodesWithTag("chat.more").onFirst().performClick()
        settle()
        compose.onNodeWithTag("menu.mode.simple").assertIsSelected()
        shot("chat-more-menu-mode")
        Espresso.pressBack()
    }

    /**
     * The computer menu at the top left: Sign out or disconnect, no pairing (that is in Computers),
     * and Search chats, which puts the mode pill away until Cancel.
     */
    @Test fun chatsMenuAndSearch() {
        computer.resident = false
        val repo = repo()
        runBlocking { repo.load() }
        compose.setContent {
            NekkoTheme(dark = false) {
                CompositionLocalProvider(LocalSimple provides rememberSimpleView(prefs)) {
                    ChatsScreen(repo, onOpenChat = {}, onNewChat = {}, onPair = {}, onComputers = {}, onSettings = {}, onMonitors = {})
                }
            }
        }
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Tidy the release notes")).fetchSemanticsNodes().isNotEmpty() }
        settle()
        compose.onAllNodesWithTag("chats.menu").onFirst().performClick()
        settle()
        assertTrue(compose.onAllNodes(hasText("Sign out or disconnect")).fetchSemanticsNodes().isNotEmpty())
        assertEquals(0, compose.onAllNodes(hasText("Pair another computer")).fetchSemanticsNodes().size)
        shot("chats-menu")

        compose.onAllNodesWithTag("chats.menu.search").onFirst().performClick()
        settle()
        assertTrue(compose.onAllNodesWithTag("chats.search").fetchSemanticsNodes().isNotEmpty())
        compose.onAllNodesWithTag("chats.search").onFirst().performTextInput("image")
        settle()
        assertTrue(compose.onAllNodes(hasText("Profile the image cache")).fetchSemanticsNodes().isNotEmpty())
        assertEquals(0, compose.onAllNodes(hasText("Tidy the release notes")).fetchSemanticsNodes().size)
        shot("chats-search")

        compose.onAllNodesWithContentDescription("Cancel search").onFirst().performClick()
        settle()
        assertEquals(0, compose.onAllNodesWithTag("chats.search").fetchSemanticsNodes().size)
        assertTrue(compose.onAllNodes(hasText("Tidy the release notes")).fetchSemanticsNodes().isNotEmpty())
    }

    /**
     * The mode pill in Expert with a local model: at the top, a tap on its gauges opens the details
     * (Done closes them), and a long press dragged to the right edge docks it upright there, saved
     * for the phone.
     */
    @Test fun pillExpandsAndDocks() {
        prefs.set(EXPERT_MODE, true)
        show()
        compose.waitUntil(15_000) { compose.onAllNodesWithTag(ModeTags.MONITOR).fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(10_000) { computer.calls.contains(Channels.SYSTEM_STATS) }
        settle()
        val pill = compose.onAllNodesWithTag(PILL_TAG).onFirst()
        val bar = pill.fetchSemanticsNode().boundsInRoot
        shot("pill-top")

        compose.onAllNodesWithContentDescription("CPU, 38%").onFirst().performClick()
        settle()
        assertTrue(compose.onAllNodesWithTag(ModeTags.MONITOR_SHEET).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasText("Unload")).fetchSemanticsNodes().isNotEmpty())
        shot("pill-expanded")
        compose.onAllNodes(hasText("Done")).onFirst().performClick()
        settle()
        assertEquals(0, compose.onAllNodesWithTag(ModeTags.MONITOR_SHEET).fetchSemanticsNodes().size)

        // Long press, then drag to the right edge and let go a little lower down.
        val width = compose.onRoot().fetchSemanticsNode().size.width
        val dx = width - 24f - bar.center.x
        compose.onAllNodesWithTag(PILL_TAG).onFirst().performTouchInput {
            down(center)
            advanceEventTime(700)
            repeat(12) { moveBy(Offset(dx / 12, 20f)) }
            up()
        }
        settle()
        assertEquals(PillDock.RIGHT, prefs.get(PillPlace.KEY).dock)
        val docked = compose.onAllNodesWithTag(PILL_TAG).onFirst().fetchSemanticsNode().boundsInRoot
        assertTrue("upright: $docked", docked.height > docked.width)
        assertTrue("on the right: $docked", docked.right > width * 0.9f)
        shot("pill-docked-right")
        prefs.reset(PillPlace.KEY)
    }

    /** A swipe into its edge tucks the pill into a slim tab; a tap on the tab brings it back. */
    @Test fun pillTucksIntoItsEdge() {
        prefs.set(PillPlace.KEY, PillPlace(PillDock.RIGHT, 0.3f))
        show()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag(PILL_TAG).fetchSemanticsNodes().isNotEmpty() }
        settle()
        compose.onAllNodesWithTag(PILL_TAG).onFirst().performTouchInput {
            down(center)
            repeat(8) { moveBy(Offset(25f, 0f)) }
            up()
        }
        settle()
        assertTrue(prefs.get(PillPlace.KEY).tucked)
        assertEquals(0, compose.onAllNodesWithTag(PILL_TAG).fetchSemanticsNodes().size)
        val tab = compose.onAllNodesWithTag(PILL_TAB_TAG).onFirst().fetchSemanticsNode().boundsInRoot
        val width = compose.onRoot().fetchSemanticsNode().size.width
        assertTrue("against the right edge: $tab", tab.right >= width - 1f)
        shot("pill-tucked-right")
        compose.onAllNodesWithTag(PILL_TAB_TAG).onFirst().performClick()
        settle()
        assertEquals(PillPlace(PillDock.RIGHT, 0.3f), prefs.get(PillPlace.KEY))

        // Under the top bar, a swipe up tucks it into the bar.
        prefs.set(PillPlace.KEY, PillPlace.DEFAULT)
        settle()
        compose.onAllNodesWithTag(PILL_TAG).onFirst().performTouchInput {
            down(center)
            repeat(8) { moveBy(Offset(0f, -25f)) }
            up()
        }
        settle()
        assertEquals(PillPlace(tucked = true), prefs.get(PillPlace.KEY))
        shot("pill-tucked-top")
        compose.onAllNodesWithTag(PILL_TAB_TAG).onFirst().performClick()
        settle()
        assertEquals(PillPlace.DEFAULT, prefs.get(PillPlace.KEY))
        prefs.reset(PillPlace.KEY)
    }

    /** In a long chat, reading on slides the pill away; scrolling back brings it back. */
    @Test fun pillHidesOnScroll() {
        // A local model loaded: the pill has gauges to show (with none there is no pill, #2117).
        computer.resident = true
        computer.manyMessages = true
        show()
        compose.waitUntil(15_000) { compose.onAllNodesWithTag(PILL_TAG).fetchSemanticsNodes().isNotEmpty() }
        compose.onRoot().performTouchInput { swipeDown(startY = centerY - 300f, endY = centerY + 300f) }
        settle()
        assertTrue(compose.onAllNodesWithTag(PILL_TAG).fetchSemanticsNodes().isNotEmpty())
        compose.onRoot().performTouchInput { swipeUp(startY = centerY + 200f, endY = centerY - 200f) }
        settle()
        assertEquals(0, compose.onAllNodesWithTag(PILL_TAG).fetchSemanticsNodes().size)
        shot("pill-scrolled-away")
        compose.onRoot().performTouchInput { swipeDown(startY = centerY - 200f, endY = centerY + 200f) }
        settle()
        assertTrue(compose.onAllNodesWithTag(PILL_TAG).fetchSemanticsNodes().isNotEmpty())
    }

    /** Effort shows in Simple too: the slider in the sheet, and High sets it. */
    @Test fun effortInSimple() {
        computer.resident = false
        show()
        compose.onAllNodesWithTag(ModeTags.MODEL_EFFORT).onFirst().performClick()
        settle()
        shot("effort-simple")
        compose.onAllNodesWithTag(ModeTags.effort(com.nekko.protocol.Effort.HIGH)).onFirst().performClick()
        compose.waitUntil(5_000) { computer.effort == "high" }
        settle()
        shot("effort-simple-high")
    }

    /** Simple's "getting long" line once the context passes 85% of the window. */
    @Test fun longChatLine() {
        computer.resident = false
        computer.longChat = true
        show()
        compose.waitUntil(5_000) { compose.onAllNodesWithTag(ModeTags.LONG_CHAT).fetchSemanticsNodes().isNotEmpty() }
        assertTrue(compose.onAllNodes(hasText("This chat is getting long. Starting fresh saves about 112k tokens.")).fetchSemanticsNodes().isNotEmpty())
        settle()
        shot("chat-long")
        // Start fresh hands New chat the same model.
        compose.onAllNodes(hasText("Start fresh")).onFirst().performClick()
        compose.waitForIdle()
        assertEquals(com.nekko.android.data.ModelPick("anthropic", "claude-opus-4-7"), fresh)
        compose.onAllNodesWithContentDescription("Dismiss").onFirst().performClick()
        settle()
        assertEquals(0, compose.onAllNodesWithTag(ModeTags.LONG_CHAT).fetchSemanticsNodes().size)
    }

    /** Identical gestures on base/head; the baseline must keep its pill, not invent a tab. */
    @Test fun pillTuckEvidence() {
        val baseline = InstrumentationRegistry.getArguments().getString("nekkoPillBaseline") == "true"
        prefs.set(PillPlace.KEY, PillPlace(PillDock.RIGHT, 0.3f))
        show()
        compose.waitUntil(10_000) { computer.calls.contains(Channels.SYSTEM_STATS) }
        settle()
        shot("evidence-right-initial")
        compose.onAllNodesWithTag(PILL_TAG).onFirst().performTouchInput {
            down(center)
            repeat(8) { moveBy(Offset(25f, 0f)) }
            up()
        }
        settle()
        shot("evidence-right-after-swipe")
        assertEquals(if (baseline) 0 else 1, compose.onAllNodesWithTag("simple.pill.tab").fetchSemanticsNodes().size)
        if (!baseline) {
            compose.onAllNodesWithTag("simple.pill.tab").onFirst().performClick()
            settle()
            assertTrue(compose.onAllNodesWithTag(PILL_TAG).fetchSemanticsNodes().isNotEmpty())
            shot("evidence-right-restored")
        }
        prefs.set(PillPlace.KEY, PillPlace.DEFAULT)
        settle()
        shot("evidence-top-initial")
        compose.onAllNodesWithTag(PILL_TAG).onFirst().performTouchInput {
            down(center)
            repeat(8) { moveBy(Offset(0f, -25f)) }
            up()
        }
        settle()
        shot("evidence-top-after-swipe")
        assertEquals(if (baseline) 0 else 1, compose.onAllNodesWithTag("simple.pill.tab").fetchSemanticsNodes().size)
        if (!baseline) {
            compose.onAllNodesWithTag("simple.pill.tab").onFirst().performClick()
            settle()
            assertTrue(compose.onAllNodesWithTag(PILL_TAG).fetchSemanticsNodes().isNotEmpty())
            shot("evidence-top-restored")
        }
        prefs.reset(PillPlace.KEY)
    }

    /** Settings > Simple mode, previewing Simple. */
    @Test fun simpleModeSettings() {
        compose.setContent { NekkoTheme(dark = false) { SimpleModeScreen(prefs, onBack = {}) } }
        settle()
        assertTrue(compose.onAllNodes(hasText("Simple is a cleaner, more focused view, and details show only when they matter. Everything still works.")).fetchSemanticsNodes().isNotEmpty())
        shot("settings-simple-mode")
    }

    /** A repository paired with the fake computer, named Studio Mac. */
    private fun repo(): ComputersRepository {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val repo = ComputersRepository(
            store = MemoryStore(),
            remotes = { config, _ -> computer.remote(config) },
            scope = scope,
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
        )
        runBlocking {
            val id = repo.pair(testPairing())
            repo.rename(id, "Studio Mac")
        }
        return repo
    }

    /** One chat on a phone; two side by side (Chat + Chat) on an open folding phone. */
    private fun show() {
        val repo = repo()
        val vms = mapOf("s1" to ChatViewModel("s1", repo, null, prefs), "s2" to ChatViewModel("s2", repo, null, prefs))
        compose.setContent {
            NekkoTheme(dark = false) {
                val window = rememberWindowPosture()
                if (window.mode == PaneMode.ONE) {
                    ChatScreen(vms.getValue("s1"), onBack = {}, onStartFresh = { fresh = it })
                    return@NekkoTheme
                }
                var layout by remember { mutableStateOf(PaneLayout(PaneContent.Chat("s1"), PaneContent.Chat("s2"), focused = PaneSide.FIRST)) }
                LaunchedEffect(window.mode) { layout = layout.forMode(window.mode, null) }
                PanesHost(
                    window = window,
                    layout = layout,
                    onChange = { change -> layout = change(layout).normalized(window.mode) },
                    labels = PaneLabels { c -> (c as? PaneContent.Chat)?.id ?: c.key },
                    chats = emptyList(),
                    waiting = emptySet(),
                    tip = null,
                    onTakeTip = {},
                    onDismissTip = {},
                    noteDismissed = true,
                    onDismissNote = {},
                ) { slot ->
                    val id = (slot.content as PaneContent.Chat).id ?: "s1"
                    ChatScreen(vms.getValue(id), onBack = slot.back, pane = slot)
                }
            }
        }
        compose.waitUntil(10_000) { computer.calls.contains(Channels.CONTEXT_PREVIEW) }
        settle()
    }

    /** Simple or Detailed from a chat's ⋮ menu, where the mode is now (#2117). */
    private fun chooseMode(expert: Boolean) {
        compose.onAllNodesWithTag("chat.more").onFirst().performClick()
        settle()
        compose.onNodeWithTag(if (expert) "menu.mode.detailed" else "menu.mode.simple").performClick()
        settle()
    }

    private fun settle() {
        compose.waitForIdle()
        Thread.sleep(700)
        compose.waitForIdle()
    }

    /** The whole screen, so sheets, menus and the status bar show as on the phone. */
    private fun shot(name: String) {
        // takeScreenshot is null now and then while the display is busy; a moment later it isn't.
        var shot: Bitmap? = null
        for (i in 0 until 10) {
            shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            if (shot != null) break
            Thread.sleep(300)
        }
        val bitmap = shot ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "modes-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class MemoryStore : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    /** The computer as the phone gate answers it: a Claude chat, the hardware, one loaded local model. */
    class FakeComputer {
        private companion object {
            const val T0 = 1_760_000_000_000L
        }

        val calls = CopyOnWriteArrayList<String>()
        /** When this computer was made: its chats were last touched just before. */
        private val now = System.currentTimeMillis()
        /** Each chat's effort, as `session:setOptions` left it. */
        val efforts = java.util.concurrent.ConcurrentHashMap<String, String>()
        val effort: String? get() = efforts["s1"]
        @Volatile var resident = true
        /** The chat has filled most of its window: Simple's "getting long" line. */
        @Volatile var longChat = false
        /** Forty more exchanges before the last turn, so the chat scrolls. */
        @Volatile var manyMessages = false
        /** The finished reply carries the computer's turn measurements (#2112). */
        @Volatile var turnStats = false
        /** session:get takes this long, so a refresh can be seen turning (milliseconds). */
        @Volatile var slowGet = 0L

        private fun json(s: String): JsonElement = WireJson.parseToJsonElement(s)

        private fun session(id: String) = buildJsonObject {
            put("id", id)
            put("title", if (id == "s1") "Tidy the release notes" else "Profile the image cache")
            put("providerId", "anthropic")
            put("modelId", "claude-opus-4-7")
            efforts[id]?.let { put("effort", it) }
            put("updatedAt", 1)
            put("queue", JsonArray(emptyList()))
            put(
                "messages",
                buildJsonArray {
                    if (manyMessages) for (i in 0 until 40) {
                        add(buildJsonObject { put("id", "$id-m$i"); put("role", if (i % 2 == 0) "user" else "assistant"); put("createdAt", T0 - 100_000 + i); put("content", "Earlier message $i about the release notes.") })
                    }
                    add(buildJsonObject { put("id", "$id-u"); put("role", "user"); put("createdAt", T0); put("content", "Group the release notes by area and drop the duplicates.") })
                    // The turn's steps: a thought and two tool calls, which Simple folds into one line.
                    add(
                        buildJsonObject {
                            put("id", "$id-a0"); put("role", "assistant"); put("createdAt", T0 + 2_000); put("content", "")
                            put("reasoning", "The notes repeat a few fixes. Read them first, then count the bullets.")
                            put(
                                "toolCalls",
                                buildJsonArray {
                                    add(buildJsonObject { put("id", "$id-c1"); put("name", "read_file"); put("input", buildJsonObject { put("path", "RELEASE_NOTES.md") }) })
                                    add(buildJsonObject { put("id", "$id-c2"); put("name", "bash"); put("input", buildJsonObject { put("command", "grep -c '^- ' RELEASE_NOTES.md") }) })
                                },
                            )
                        },
                    )
                    add(buildJsonObject { put("id", "$id-r1"); put("role", "tool"); put("toolResult", buildJsonObject { put("toolCallId", "$id-c1"); put("output", "# Release notes\n- Faster chat list\n- Faster chat list"); put("isError", false) }) })
                    add(buildJsonObject { put("id", "$id-r2"); put("role", "tool"); put("toolResult", buildJsonObject { put("toolCallId", "$id-c2"); put("output", "17"); put("isError", false) }) })
                    add(buildJsonObject {
                        put("id", "$id-a"); put("role", "assistant"); put("createdAt", T0 + 14_000); put("content", "Done: 14 notes in 4 areas (Chat, Phone, Models, Settings). I removed 3 duplicates and kept the clearer wording of each.")
                        // The computer's persisted measurements for the turn (#2112): a turn that ran to the end.
                        if (turnStats) put("turnStats", buildJsonObject {
                            put("providerId", "anthropic"); put("modelId", "claude-opus-4-7"); put("effort", "high")
                            put("inputTokens", 2_400); put("cacheReadTokens", 9_800); put("outputTokens", 612)
                            put("outputMs", 8_200); put("wallMs", 14_300); put("calls", 3); put("stop", "complete")
                        })
                    })
                },
            )
        }

        fun answer(channel: String, args: List<JsonElement>): JsonElement {
            calls += channel
            return when (channel) {
                Channels.SETTINGS_GET -> json("""{"defaultProviderId":"anthropic","defaultModelId":"claude-opus-4-7"}""")
                Channels.PROVIDERS_LIST -> json("""[{"id":"anthropic","kind":"anthropic","label":"Anthropic","enabled":true},{"id":"nekko-engine","kind":"nekko-engine","label":"Model Server","enabled":true}]""")
                Channels.MODELS_LIST -> when (args.firstOrNull()?.jsonPrimitive?.content) {
                    "anthropic" -> json("""[{"id":"claude-opus-4-7","providerId":"anthropic","name":"Claude Opus 4.7"},{"id":"claude-sonnet-4-5","providerId":"anthropic","name":"Claude Sonnet 4.5"}]""")
                    else -> json("""[{"id":"google/gemma-4-e4b","providerId":"nekko-engine","name":"Gemma 4 E4B","loaded":true}]""")
                }
                // Touched a minute ago: a group lists only recent chats before Show more (ChatSections.split).
                Channels.SESSIONS_SUMMARIES -> json("""[{"id":"s1","title":"Tidy the release notes","updatedAt":${now - 60_000}},{"id":"s2","title":"Profile the image cache","updatedAt":${now - 120_000}}]""")
                Channels.SESSION_GET -> session(args.first().jsonPrimitive.content)
                Channels.SESSION_SET_OPTIONS -> {
                    args.getOrNull(1)?.jsonObject?.get("effort")?.let { efforts[args.first().jsonPrimitive.content] = it.jsonPrimitive.content }
                    session(args.first().jsonPrimitive.content)
                }
                Channels.CONTEXT_PREVIEW -> if (longChat) {
                    json("""{"usedTokens":176000,"contextWindow":200000,"sources":{"system":6200,"conversation":112000,"attached-file":48000,"guideline":5800,"memory":4000}}""")
                } else json("""{"usedTokens":86400,"contextWindow":200000,"sources":{"system":6200,"conversation":61800,"attached-file":12400,"guideline":3800,"memory":2200}}""")
                Channels.SYSTEM_STATS -> json("""{"cpuPct":38,"cpuCores":16,"memUsedMB":21800,"memTotalMB":32768,"temps":{"cpuC":64,"gpuC":71}}""")
                Channels.GPU_STATS -> json("""{"totalMB":24576,"usedMB":9400,"unified":false,"devices":[{"utilizationPct":72}]}""")
                Channels.ENGINE_STATUS -> json(
                    """{"installed":true,"running":true,
                    "resident":${if (resident) """[{"id":"google/gemma-4-e4b","contextLength":32768,"vramBytes":5100000000,"loadedOn":"gpu","gpuLayers":42,"totalLayers":42}]""" else "[]"},
                    "loading":[],"memory":{"budgetBytes":22000000000,"kind":"vram"}}""",
                )
                Channels.MODEL_UNLOAD -> {
                    resident = false
                    json("""{"ok":true,"message":"Unloaded Gemma 4 E4B."}""")
                }
                Channels.WORKSPACE_LIST -> JsonArray(emptyList())
                else -> JsonNull
            }
        }

        fun remote(config: RelayConfig): Remote = object : Remote {
            override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
            override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64)
            override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
            override fun connect() { status.value = RelayStatus(RelayState.ONLINE) }
            override fun close() { status.value = RelayStatus(RelayState.IDLE) }
            override fun nudge() {}
            override fun reconnect() {}
            override suspend fun call(channel: String, vararg args: JsonElement): JsonElement {
                if (channel == Channels.SESSION_GET && slowGet > 0) kotlinx.coroutines.delay(slowGet)
                return answer(channel, args.toList())
            }
            override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = answer(channel, args.toList())
        }
    }
}
