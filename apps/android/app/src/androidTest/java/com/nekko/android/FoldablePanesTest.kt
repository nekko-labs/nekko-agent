package com.nekko.android

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowMetricsCalculator
import androidx.window.testing.layout.FoldingFeature as TestFoldingFeature
import androidx.window.testing.layout.TestWindowLayoutInfo
import androidx.window.testing.layout.WindowLayoutInfoPublisherRule
import com.nekko.android.ui.chat.ApprovalCard
import com.nekko.android.ui.chat.ChatColumns
import com.nekko.android.ui.chat.Composer
import com.nekko.android.ui.panes.PaneLabels
import com.nekko.android.ui.panes.PaneSlot
import com.nekko.android.ui.panes.PaneTags
import com.nekko.android.ui.panes.PanesHost
import com.nekko.android.ui.panes.rememberWindowPosture
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Approval
import com.nekko.protocol.PaneContent
import com.nekko.protocol.PaneLayout
import com.nekko.protocol.PaneMode
import com.nekko.protocol.PaneSide
import com.nekko.protocol.Severity
import com.nekko.protocol.ToolCall
import java.io.File
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.runner.RunWith

/**
 * The folding-phone panes against a faked `FoldingFeature` (window-testing), on the
 * emulator's foldable profiles: the 7.6" Fold-in (Pixel Fold class), the 8" Fold-out
 * and Microsoft Surface Duo. Each test needs the open inner screen (600 dp or wider)
 * and is skipped on anything smaller, so the suite can run on every CI device.
 *
 * Every pane holds the real chat layout ([ChatColumns]) with a real [ApprovalCard]
 * and [Composer], so the tabletop check covers the controls the app draws. Each state
 * is a screenshot under the app's external files (`evidence/`), light or dark by
 * `-e nekkoTheme`.
 */
@RunWith(AndroidJUnit4::class)
class FoldablePanesTest {
    private val compose = createAndroidComposeRule<ComponentActivity>()
    private val publisher = WindowLayoutInfoPublisherRule()

    @get:Rule val rules: RuleChain = RuleChain.outerRule(publisher).around(compose)

    private val theme = InstrumentationRegistry.getArguments().getString("nekkoTheme") ?: "light"

    private val approval = Approval(
        ToolCall("tc1", "bash", buildJsonObject { put("command", JsonPrimitive("rm -rf build/")) }),
        reason = "",
        severity = Severity.HIGH,
    )

    /** Two chat panes; the test's layout state stands in for PanesViewModel. */
    private fun showPanes(start: PaneLayout = PaneLayout(PaneContent.Chat("a"), PaneContent.Chat("b"), focused = PaneSide.FIRST)) {
        compose.setContent {
            NekkoTheme(dark = theme == "dark") {
                val window = rememberWindowPosture()
                var layout by remember { mutableStateOf(start) }
                LaunchedEffect(window.mode) { layout = layout.forMode(window.mode, null) }
                if (window.mode == PaneMode.ONE) return@NekkoTheme
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
                ) { slot -> FakeChatPane(slot) }
            }
        }
    }

    @androidx.compose.runtime.Composable
    private fun FakeChatPane(slot: PaneSlot) {
        Box {
            ChatColumns(
                top = HEADER,
                tabletop = slot.tabletop,
                transcript = { m ->
                    LazyColumn(m) {
                        items((1..40).toList()) { i ->
                            Text("Message $i in ${slot.content.key}", Modifier.fillMaxWidth().clickable {}.padding(12.dp))
                        }
                    }
                },
                controls = {
                    ApprovalCard(approval, onDecide = {})
                    Composer(running = false, blocked = null, queued = emptyList(), onSend = { _, _, _ -> }, onStop = {})
                },
            )
            Row(Modifier.fillMaxWidth().height(HEADER), verticalAlignment = Alignment.CenterVertically) {
                Text(slot.content.key, Modifier.weight(1f).padding(horizontal = 12.dp))
                slot.actions(this)
            }
        }
    }

    private fun openInnerScreen(): Rect {
        val bounds = WindowMetricsCalculator.getOrCreate().computeCurrentWindowMetrics(compose.activity).bounds
        val density = compose.activity.resources.displayMetrics.density
        assumeTrue("needs a foldable profile's open inner screen (600 dp or wider)", bounds.width() / density >= 600f && bounds.height() / density >= 480f)
        return bounds
    }

    private fun publish(feature: FoldingFeature) {
        lastPublished = feature
        compose.runOnUiThread { publisher.overrideWindowLayoutInfo(TestWindowLayoutInfo(listOf(feature))) }
        compose.waitForIdle()
    }

    private fun bounds(tag: String): Rect {
        val b = compose.onNode(SemanticsMatcher.expectValue(SemanticsProperties.TestTag, tag), useUnmergedTree = true)
            .fetchSemanticsNode().boundsInWindow
        return Rect(b.left.toInt(), b.top.toInt(), b.right.toInt(), b.bottom.toInt())
    }

    @Test
    fun bookPostureSnapsTheDividerToTheHinge() {
        showPanes()
        openInnerScreen()
        publish(TestFoldingFeature(compose.activity, state = FoldingFeature.State.HALF_OPENED, orientation = FoldingFeature.Orientation.VERTICAL))
        val hinge = currentHinge()
        val first = bounds(PaneTags.FIRST)
        val second = bounds(PaneTags.SECOND)
        assertTrue("left pane ends at the hinge: $first vs $hinge", first.right <= hinge.left + 1)
        assertTrue("right pane starts after the hinge: $second vs $hinge", second.left >= hinge.right - 1)
        shot("book")
    }

    @Test
    fun tabletopKeepsEveryControlOffTheHinge() {
        showPanes()
        openInnerScreen()
        publish(TestFoldingFeature(compose.activity, state = FoldingFeature.State.HALF_OPENED, orientation = FoldingFeature.Orientation.HORIZONTAL))
        val hinge = currentHinge()
        val controls = compose.onAllNodes(hasClickAction() or hasSetTextAction(), useUnmergedTree = true).fetchSemanticsNodes()
        assertTrue("the composer, the approval card and the transcript are on screen", controls.size > 4)
        for (n in controls) {
            val b = n.boundsInWindow
            if (b.width <= 0f || b.height <= 0f) continue // scrolled out of the clipped transcript
            // A zero-height hinge (a Fold's) is a line: straddling it means crossing it.
            val straddles = b.top < hinge.bottom.toFloat() && b.bottom > hinge.top.toFloat()
            assertTrue("control ${n.config} at $b lies under the hinge $hinge", !straddles)
        }
        // The message box is below the hinge; the other pane's edge tab above it.
        val box = compose.onAllNodes(hasSetTextAction(), useUnmergedTree = true).fetchSemanticsNodes().single().boundsInWindow
        assertTrue("message box below the hinge", box.top >= hinge.bottom)
        assertTrue("edge tab above the hinge", bounds(PaneTags.EDGE_TAB).bottom <= hinge.top)
        shot("tabletop")
    }

    /** Surface Duo: the gap between the two screens is the divider; nothing is drawn across it. */
    @Test
    fun separatingHingeIsTheDivider() {
        showPanes()
        openInnerScreen()
        val density = compose.activity.resources.displayMetrics.density
        // Surface Duo's gap is 84 px (34 dp at 2.5x); scale it for the profile's density.
        val gap = (34 * density).toInt()
        publish(TestFoldingFeature(compose.activity, size = gap, state = FoldingFeature.State.FLAT, orientation = FoldingFeature.Orientation.VERTICAL))
        val hinge = currentHinge()
        assumeTrue("the fake feature separates (window-testing marks a sized fold as separating)", currentFeature()?.isSeparating == true)
        val first = bounds(PaneTags.FIRST)
        val second = bounds(PaneTags.SECOND)
        assertTrue("left pane ends where the gap starts", first.right <= hinge.left + 1)
        assertTrue("right pane starts where the gap ends", second.left >= hinge.right - 1)
        assertEquals("the divider is the gap", hinge.width().toFloat(), bounds(PaneTags.DIVIDER).width().toFloat(), 2f)
        shot("surface-duo")
    }

    /** Rotating to tall stacks the two chats, the focused one on top. */
    @Test
    fun openTallStacksTheFocusedChatOnTop() {
        showPanes(PaneLayout(PaneContent.Chat("a"), PaneContent.Chat("b"), focused = PaneSide.SECOND))
        val window = openInnerScreen()
        assumeTrue("needs the tall orientation (height over width above 1.3)", window.height().toFloat() / window.width() > 1.3f)
        publish(TestFoldingFeature(compose.activity, state = FoldingFeature.State.FLAT, orientation = FoldingFeature.Orientation.HORIZONTAL))
        val first = bounds(PaneTags.FIRST)
        val second = bounds(PaneTags.SECOND)
        assertTrue("stacked: the first pane is above the second", first.bottom <= second.top + 1)
        shot("open-tall")
    }

    /** The fold last handed to the app (the rule delivers exactly this to WindowInfoTracker). */
    private var lastPublished: FoldingFeature? = null

    private fun currentFeature(): FoldingFeature? = lastPublished

    /** The faked fold's bounds in window pixels, as the app reads them. */
    private fun currentHinge(): Rect = Rect(lastPublished!!.bounds)

    private fun shot(name: String) {
        compose.waitForIdle()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "foldable-$theme-$name-${Build.MODEL.replace(' ', '_')}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private companion object {
        val HEADER = 56.dp
    }
}
