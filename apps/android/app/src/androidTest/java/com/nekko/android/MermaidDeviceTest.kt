package com.nekko.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.mermaid.MermaidRenderer
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * MM-4 on a device: the bundled Mermaid draws a flowchart and a sequence
 * diagram in the locked WebView, a broken diagram fails with Mermaid's own
 * words, and the renderer's page cannot reach the network.
 */
@RunWith(AndroidJUnit4::class)
class MermaidDeviceTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun drawsDiagramsAndABrokenOneSaysWhy() = runBlocking {
        val flow = MermaidRenderer.draw(context, "graph TD\nA[Start] --> B{Ok?}\nB -->|yes| C[Ship]\nB -->|no| A", dark = false, width = 320, scale = 2f)
        assertTrue(flow.svg.startsWith("<svg"))
        assertTrue("drawn at the bubble's width or less", flow.image.width in 1..640)
        val seq = MermaidRenderer.draw(context, "sequenceDiagram\nPhone->>Computer: hello\nComputer-->>Phone: hi", dark = true, width = 360, scale = 2f)
        assertTrue(seq.image.height > 0)
        val broken = runCatching { MermaidRenderer.draw(context, "graph TD\nA -->", dark = false, width = 320, scale = 2f) }.exceptionOrNull()
        assertTrue("Mermaid's error, said: ${broken?.message}", broken is MermaidRenderer.Failure && broken.message!!.isNotBlank())
        // The second time comes from the cache.
        assertTrue(MermaidRenderer.cached(context, "graph TD\nA[Start] --> B{Ok?}\nB -->|yes| C[Ship]\nB -->|no| A", false, 320, 2f) != null)
    }

    @Test fun theRendererCannotReachTheNetwork() = runBlocking {
        assertEquals("blocked", MermaidRenderer.networkProbe(context))
    }
}
