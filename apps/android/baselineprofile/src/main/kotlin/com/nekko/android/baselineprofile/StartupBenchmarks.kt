package com.nekko.android.baselineprofile

import androidx.benchmark.macro.BaselineProfileMode
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Cold start to the first frame, without and with the Baseline Profile.
 * `./gradlew :baselineprofile:connectedBenchmarkReleaseAndroidTest` (see apps/android/README.md).
 */
@RunWith(AndroidJUnit4::class)
class StartupBenchmarks {
    @get:Rule
    val rule = MacrobenchmarkRule()

    @Test
    fun coldStartNoProfile() = start(CompilationMode.None())

    @Test
    fun coldStartBaselineProfile() = start(CompilationMode.Partial(BaselineProfileMode.Require))

    private fun start(mode: CompilationMode) = rule.measureRepeated(
        packageName = TARGET_PACKAGE,
        metrics = listOf(StartupTimingMetric()),
        compilationMode = mode,
        startupMode = StartupMode.COLD,
        iterations = 10,
        setupBlock = { pressHome() },
    ) {
        startActivityAndWait()
    }
}
