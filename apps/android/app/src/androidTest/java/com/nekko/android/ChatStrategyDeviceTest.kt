package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.chat.BlockView
import com.nekko.android.ui.chat.TurnStrategyRow
import com.nekko.android.ui.screens.TranscriptRow
import com.nekko.android.ui.screens.transcriptRows
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Block
import com.nekko.protocol.PurposeRun
import com.nekko.protocol.TurnStrategy
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Real transcript projection and native rows, with only synthetic content. */
class ChatStrategyDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun showsStrategyAndModelsAfterEachPrompt() {
        val messages = listOf(
            Block.User("u1", "Read the project brief."),
            Block.Assistant("a1", "The brief calls for checking both ledgers."),
            Block.User("u2", "What is the review cycle?"),
            Block.Assistant("a2", "The review cycle is 17 days."),
            Block.User("u3", "Delegate the ledger review."),
            Block.Assistant("a3", "The ledgers agree with the audit totals."),
        )
        val direct = TurnStrategy(TurnStrategy.Tools.LIST, TurnStrategy.Orchestration.DIRECT, modelId = "gpt-fixture")
        val coordinator = TurnStrategy(TurnStrategy.Tools.CODE, TurnStrategy.Orchestration.COORDINATOR, modelId = "gpt-fixture", subagentModelId = "gpt-fixture-mini")
        val rows = transcriptRows(messages.map { it.id to it }, true, false, emptySet(), strategies = mapOf("u1" to direct, "u2" to direct, "u3" to coordinator))
        compose.setContent {
            NekkoTheme(dark = false) {
                Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    for (row in rows) when (row) {
                        is TranscriptRow.Strategy -> TurnStrategyRow(row.strategy)
                        is TranscriptRow.Run -> when (val run = row.run) {
                            is PurposeRun.Single -> BlockView(run.item.second)
                            is PurposeRun.Group -> run.items.forEach { BlockView(it.second) }
                        }
                        else -> Unit
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.onAllNodes(hasText("The ledgers agree with the audit totals.")).assertCountEquals(1)
        compose.onAllNodes(hasText("Strategy")).assertCountEquals(3)
        compose.onAllNodes(hasText("Tool list · Direct")).assertCountEquals(2)
        compose.onAllNodes(hasText("Code mode · Orchestration")).assertCountEquals(1)
        compose.onAllNodes(hasText("Model: gpt-fixture")).assertCountEquals(3)
        compose.onAllNodes(hasText("Planned sub-agent model: gpt-fixture-mini")).assertCountEquals(1)
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: error("No strategy screenshot")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "chat-strategy.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
