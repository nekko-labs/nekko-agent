package com.nekko.android.baselineprofile

import androidx.benchmark.macro.BaselineProfileMode
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Frame timing of a 300-message chat: scrolling it, and streaming a long reply into it with the app's
 * own per-token path against the per-token rebuild it replaced (#3410).
 */
@RunWith(AndroidJUnit4::class)
class LongChatBenchmarks {
    @get:Rule
    val rule = MacrobenchmarkRule()

    @Test
    fun scrollNoProfile() = scroll(CompilationMode.None())

    @Test
    fun scrollBaselineProfile() = scroll(CompilationMode.Partial(BaselineProfileMode.Require))

    @Test
    fun streamIntoLongChat() = stream("stream")

    @Test
    fun streamIntoLongChatLegacyRebuild() = stream("stream-legacy")

    private fun scroll(mode: CompilationMode) = rule.measureRepeated(
        packageName = TARGET_PACKAGE,
        metrics = listOf(FrameTimingMetric()),
        compilationMode = mode,
        startupMode = StartupMode.WARM,
        iterations = 8,
        setupBlock = { pressHome() },
    ) {
        startLongChat("scroll")
        scrollLongChat()
    }

    private fun stream(mode: String) = rule.measureRepeated(
        packageName = TARGET_PACKAGE,
        metrics = listOf(FrameTimingMetric()),
        compilationMode = CompilationMode.Partial(BaselineProfileMode.Disable),
        startupMode = StartupMode.WARM,
        iterations = 5,
        setupBlock = { pressHome() },
    ) {
        startLongChat(mode)
        awaitStreamDone()
    }
}
