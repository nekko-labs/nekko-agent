package com.nekko.android

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import com.nekko.android.lock.PixelOpening
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * #2120: the lock screen's opening builds the cat over its first frames, then holds it
 * until it may open. The Compose clock is stepped by hand; the cat is counted in white pixels.
 */
class PixelOpeningTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun white(): Int {
        val map = compose.onNodeWithTag("opening").captureToImage().toPixelMap()
        var n = 0
        for (y in 0 until map.height step 2) for (x in 0 until map.width step 2) {
            val c = map[x, y]
            if (c.red > 0.8f && c.green > 0.8f && c.blue > 0.8f) n++
        }
        return n
    }

    @Test fun buildsInStepsThenHolds() {
        compose.mainClock.autoAdvance = false
        compose.setContent { PixelOpening(ready = false, still = false, onDone = {}, modifier = Modifier.fillMaxSize().testTag("opening")) }
        val seen = mutableListOf<Int>()
        repeat(12) {
            compose.mainClock.advanceTimeBy(100)
            seen += white()
        }
        // Nothing at first, then more cat as it builds, then the same finished cat while it waits.
        assertTrue("$seen", seen.first() < seen.last())
        assertTrue("$seen", seen.distinct().size >= 3)
        assertTrue("$seen", seen.takeLast(3).distinct().size == 1)
    }
}
