package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.files.FilesController
import com.nekko.android.ui.files.FilePage
import com.nekko.android.ui.files.FilesPage
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.FileRoot
import com.nekko.protocol.FilesRequest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * MM-4 in Files: a `.mmd` file opened from a chat's files draws as its
 * diagram, and *Formatted* switches it to its source. Against a fake
 * computer, offline; screenshots in `evidence/mermaid-file-*.png`.
 */
class MermaidFileDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val source = "graph TD\n  Phone[Phone] -->|opens| File[flow.mmd]\n  File --> Diagram{Drawn?}\n  Diagram -->|yes| Zoom[Full screen]\n  Diagram -->|no| Source[Source]"

    private fun read(r: FilesRequest): JsonElement = when (r.channel) {
        Channels.FILES_READ -> Json.parseToJsonElement(
            """{"path":"docs/flow.mmd","name":"flow.mmd","size":${source.length},"hash":"${"1".repeat(64)}","kind":"text","content":${Json.encodeToString(source)},"markdown":false,"editable":true}""",
        )
        else -> JsonNull
    }

    private fun show(dark: Boolean) {
        val files = FilesController(FileRoot.Chat("s1"), { read(it) }, { JsonNull })
        compose.setContent {
            NekkoTheme(dark = dark) { FilePage(FilesPage.File(files, "docs/flow.mmd"), onBack = {}, open = {}) }
        }
    }

    @OptIn(ExperimentalTestApi::class)
    private fun drawn() = compose.waitUntilAtLeastOneExists(hasTestTag("mermaid.diagram"), timeoutMillis = 20_000)

    @Test fun aMermaidFileDrawsAsItsDiagram() {
        show(dark = false)
        drawn()
        compose.onNodeWithTag("file.diagram").assertExists()
        compose.waitForIdle()
        shot("light")
        // Formatted off: the source, with line numbers.
        compose.onNodeWithContentDescription("Formatted").performClick()
        compose.onNodeWithText("graph TD").assertExists()
        compose.onNodeWithTag("mermaid.diagram").assertDoesNotExist()
        compose.waitForIdle()
        shot("source")
    }

    @Test fun darkTheme() {
        show(dark = true)
        drawn()
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
        File(dir, "mermaid-file-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
