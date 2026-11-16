package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.ConnectorHTTP
import com.nekko.android.data.Connectors
import com.nekko.android.data.SecureStore
import com.nekko.android.ui.screens.ConnectorsScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.PhoneRequest
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #2109: Settings → Connectors. GitHub connected with a token a fake GitHub accepts (Connected as
 * octocat); a token Linear turns down keeps nothing and says why. Screenshots under `evidence/`.
 */
@RunWith(AndroidJUnit4::class)
class ConnectorsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')

    private class Memory : SecureStore {
        val values = java.util.concurrent.ConcurrentHashMap<String, String>()
        override suspend fun get(key: String) = values[key]
        override suspend fun set(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
    }

    private class FakeServices : ConnectorHTTP {
        val requests = java.util.concurrent.CopyOnWriteArrayList<PhoneRequest>()
        override suspend fun send(request: PhoneRequest): Pair<Int, String> {
            requests += request
            return when {
                request.url.startsWith("https://api.github.com") -> 200 to """{"login":"octocat"}"""
                else -> 200 to """{"errors":[{"message":"Authentication required"}]}"""
            }
        }
    }

    @Test fun connectGitHubAndARefusedLinear() {
        val secrets = Memory()
        val http = FakeServices()
        val connectors = Connectors(secrets, http)
        compose.setContent { NekkoTheme(dark = false) { ConnectorsScreen(connectors, onBack = {}) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("connectors.connect.github")).fetchSemanticsNodes().isNotEmpty() }
        settle()
        shot("1-page")

        compose.onNodeWithTag("connectors.connect.github").performClick()
        compose.onNodeWithTag("connect.token").performTextInput("ghp_synthetic")
        settle()
        shot("2-connect")
        compose.onNodeWithTag("connect.save").performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Connected as octocat")).fetchSemanticsNodes().isNotEmpty() }
        assertEquals("ghp_synthetic", secrets.values["phone.connector.token.github"])

        compose.onNodeWithTag("connectors.connect.linear").performScrollTo().performClick()
        compose.onNodeWithTag("connect.token").performTextInput("lin_wrong")
        compose.onNodeWithTag("connect.save").performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("connect.error")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText("Linear turned the token down: Authentication required")).assertExists()
        assertEquals(null, secrets.values["phone.connector.token.linear"])
        settle()
        shot("3-refused")
    }

    private fun settle() {
        compose.waitForIdle()
        Thread.sleep(600)
        compose.waitForIdle()
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
        File(dir, "connectors-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
