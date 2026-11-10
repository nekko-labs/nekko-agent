package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import com.nekko.android.ui.chat.AgentContext
import com.nekko.android.ui.chat.BlockView
import com.nekko.android.ui.chat.LocalAgentContext
import com.nekko.android.ui.screens.ChatRow
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.android.ui.theme.ThemePreset
import com.nekko.protocol.Activity
import com.nekko.protocol.AgentWatch
import com.nekko.protocol.Block
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.ToolStatus
import com.nekko.protocol.WireJson
import kotlinx.serialization.json.jsonObject
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * Before/after evidence for #2451: the chat list's status glyphs and agent rows'
 * icons in light, dark and a preset. Captured from the composition itself (not the
 * screen), so the first frame is never blank. PNGs in `evidence/icons-*.png`.
 */
class IconThemeEvidenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val now = System.currentTimeMillis()
    private fun summary(json: String) = SessionSummary.from(WireJson.parseToJsonElement(json))!!
    private fun obj(json: String) = WireJson.parseToJsonElement(json).jsonObject

    private fun capture(name: String, dark: Boolean, preset: String? = null) {
        val watch = Block.Tool(
            "w", "agent_watch", "agent_watch", ToolStatus.OK, "Watch armed: w-1a2b.",
            obj("""{"action":"create","kind":"pr","url":"https://github.com/nekko-labs/nekko-agent/pull/555","timeout_seconds":3600,"prompt":"Push a fix if red."}"""),
        )
        val wake = Block.User("u", "[Agent watch w-1a2b]\nPR state changed for https://github.com/nekko-labs/nekko-agent/pull/555.\n\nContinuation requested when armed:\nPush a fix if red.", at = now)
        val ctx = AgentContext(watches = listOf(AgentWatch("w-1a2b", AgentWatch.Kind.PR, null, AgentWatch.Status.ACTIVE, now + 42 * 60_000)))
        compose.setContent {
            NekkoTheme(dark = dark, preset = ThemePreset.find(preset)) {
                CompositionLocalProvider(LocalAgentContext provides ctx) {
                    Column(
                        Modifier.testTag("evidence").fillMaxWidth().background(Nekko.palette.paper).padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        BlockView(watch)
                        BlockView(wake)
                        ChatRow(summary("""{"id":"s1","title":"Fix the reconnect","updatedAt":$now}"""), Activity.RUNNING, {}, {})
                        ChatRow(summary("""{"id":"s2","title":"Ship the release","updatedAt":$now}"""), Activity.NEEDS_YOU, {}, {})
                        ChatRow(summary("""{"id":"s3","title":"Watch PR #555","updatedAt":$now,"activeWatchCount":1}"""), null, {}, {})
                        ChatRow(summary("""{"id":"s4","title":"Written on the train","updatedAt":$now}"""), null, {}, {}, waiting = 2)
                        ChatRow(summary("""{"id":"s5","title":"Release notes","updatedAt":$now}"""), null, {}, {})
                    }
                }
            }
        }
        compose.waitForIdle()
        val bitmap = compose.onNodeWithTag("evidence").captureToImage().asAndroidBitmap()
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "icons-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun light() = capture("light", dark = false)

    @Test fun dark() = capture("dark", dark = true)

    @Test fun indigoPreset() = capture("indigo", dark = false, preset = "x-indigo-white")
}
