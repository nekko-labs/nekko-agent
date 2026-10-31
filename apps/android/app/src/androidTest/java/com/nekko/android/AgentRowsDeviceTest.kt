package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.chat.AgentContext
import com.nekko.android.ui.chat.BlockView
import com.nekko.android.ui.chat.LocalAgentContext
import com.nekko.android.ui.chat.PurposeGroupCard
import com.nekko.android.ui.chat.SubagentGroup
import com.nekko.android.ui.screens.ChatRow
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Activity
import com.nekko.protocol.AgentWatch
import com.nekko.protocol.Block
import com.nekko.protocol.Purpose
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.ToolStatus
import com.nekko.protocol.WireJson
import kotlinx.serialization.json.jsonObject
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * The agent's work as rows (the iPhone's AgentRowViews): a tool step, a purpose
 * group, an armed watch with its live chip, a wake-up, and a run of subagents,
 * with the chat list's status glyphs. Offline, no relay; screenshots in
 * `evidence/agent-rows-*.png`, light and dark.
 */
class AgentRowsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun obj(json: String) = WireJson.parseToJsonElement(json).jsonObject
    private fun summary(json: String) = SessionSummary.from(WireJson.parseToJsonElement(json))!!

    private val now = System.currentTimeMillis()
    private val watch = Block.Tool(
        "w", "agent_watch", "agent_watch", ToolStatus.OK, "Watch armed: w-1a2b. Polls every 2 min.",
        obj("""{"action":"create","kind":"pr","url":"https://github.com/nekko-labs/nekko-agent/pull/555","timeout_seconds":3600,"prompt":"Read the check logs. Push a fix if red."}"""),
    )
    private val wake = Block.User(
        "u", "[Agent watch w-1a2b]\nPR state changed for https://github.com/nekko-labs/nekko-agent/pull/555. Fetch the latest details before acting. Snapshot: {\"state\":\"open\",\"checks\":\"failing\"}\n\nContinuation requested when armed:\nRead the check logs. Push a fix if red.\n\nThis wake-up grants no new permissions.",
        at = now,
    )
    private val agents = listOf(
        Block.Tool("a1", "spawn_agent", "Delegate", ToolStatus.OK, "Found it: the timer rounds to 10 ms.", obj("""{"title":"Timer precision","task":"Find the 6 ms jitter in RouteSupervisor. Then report."}""")),
        Block.Tool("a2", "spawn_agent", "Delegate", ToolStatus.RUNNING, null, obj("""{"title":"Write the fix","task":"Write the fix for reconnect and push it.","model_id":"qwen/qwen3-coder:latest"}""")),
    )
    private val reads = listOf(
        Block.Tool("r1", "read_file", "Read AGENTS.md", ToolStatus.OK, "# Agent workflow", obj("""{"path":"AGENTS.md"}""")),
        Block.Tool("r2", "read_file", "Read CLAUDE.md", ToolStatus.OK, "See AGENTS.md", obj("""{"path":"CLAUDE.md"}""")),
    )
    private val failed = Block.Tool("t", "bash", "npm test", ToolStatus.ERROR, "1 failing\n  reconnect › keeps the route", obj("""{"command":"npm test"}"""))
    private val ctx = AgentContext(
        watches = listOf(AgentWatch("w-1a2b", AgentWatch.Kind.PR, null, AgentWatch.Status.ACTIVE, now + 42 * 60_000)),
        children = listOf(
            summary("""{"id":"c1","title":"Timer precision","modelId":"claude-sonnet-5-5-20261001","updatedAt":1,"parentSessionId":"p"}"""),
            summary("""{"id":"c2","title":"Write the fix","modelId":"qwen/qwen3-coder:latest","updatedAt":1,"parentSessionId":"p"}"""),
        ),
        activity = mapOf("c2" to Activity.RUNNING),
        running = true,
        modelId = "claude-opus-5-5",
    )

    private fun show(dark: Boolean) {
        compose.setContent {
            NekkoTheme(dark = dark) {
                CompositionLocalProvider(LocalAgentContext provides ctx) {
                    Column(
                        Modifier.fillMaxSize().background(Nekko.palette.paper).statusBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        val keyed = reads.map { it.id to it as Block }
                        val run = Purpose.group(keyed) { Purpose.role(it.second) }.single() as com.nekko.protocol.PurposeRun.Group
                        PurposeGroupCard(run.purpose, reads, run.calls)
                        BlockView(failed)
                        BlockView(watch)
                        BlockView(wake)
                        SubagentGroup(agents, ctx)
                        ChatRow(summary("""{"id":"s1","title":"Fix the reconnect","updatedAt":$now,"lastReplyText":"Two subagents are on it."}"""), Activity.RUNNING, {}, {})
                        ChatRow(summary("""{"id":"s2","title":"Ship the release","updatedAt":$now,"lastReplyText":"May I run the deploy?"}"""), Activity.NEEDS_YOU, {}, {})
                        ChatRow(summary("""{"id":"s3","title":"Watch PR #555","updatedAt":$now,"activeWatchCount":1}"""), null, {}, {})
                        ChatRow(summary("""{"id":"s4","title":"Written on the train","updatedAt":$now}"""), null, {}, {}, waiting = 2)
                    }
                }
            }
        }
    }

    @Test fun rowsSayWhatTheAgentDoes() {
        show(dark = false)
        compose.onNodeWithText("Watching PR #555 · wakes on any PR change or after 1h", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("≤ 4", substring = true, useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription("Watch triggered, PR #555 changed. open, checks failing").assertExists()
        compose.onNodeWithText("2 subagents · 1 working", useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription("Subagent Timer precision, done").assertExists()
        compose.onNodeWithContentDescription("Subagent Write the fix, working").assertExists()
        compose.onNodeWithText("qwen3-coder", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("claude-opus-5-5", useUnmergedTree = true).assertExists()
        // The failed step stays a row whose output opens under it.
        compose.onNodeWithContentDescription("npm test, failed").performClick()
        compose.onNodeWithText("reconnect › keeps the route", substring = true, useUnmergedTree = true).assertExists()
        // A subagent opens to its task and result.
        compose.onNodeWithContentDescription("Subagent Timer precision, done").performClick()
        compose.onNodeWithText("Find the 6 ms jitter in RouteSupervisor.", useUnmergedTree = true).assertExists()
        // The chat list's glyphs: rocket, question mark, Zz, clock.
        for (label in listOf("Working", "Needs you", "Idle", "Waiting to send")) {
            compose.onNodeWithContentDescription(label, useUnmergedTree = true).assertExists()
        }
        compose.waitForIdle()
        shot("light")
    }

    @Test fun darkTheme() {
        show(dark = true)
        compose.onNodeWithText("2 subagents · 1 working", useUnmergedTree = true).assertExists()
        compose.waitForIdle()
        shot("dark")
    }

    private fun shot(name: String) {
        var shot: Bitmap? = null
        for (i in 0 until 10) {
            shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            if (shot != null) break
            Thread.sleep(300)
        }
        val bitmap = shot ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "agent-rows-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
