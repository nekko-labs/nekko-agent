plugins {
    alias(libs.plugins.android.test)
    alias(libs.plugins.androidx.baselineprofile)
}

android {
    namespace = "com.nekko.android.baselineprofile"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        minSdk = 28
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // An emulator is not a phone, and the benchmark library says so unless told it knows:
        // ./gradlew ... -PbenchmarkOnEmulator (numbers from it are not device numbers).
        if (providers.gradleProperty("benchmarkOnEmulator").isPresent) {
            testInstrumentationRunnerArguments["androidx.benchmark.suppressErrors"] = "EMULATOR,LOW-BATTERY"
        }
    }

    // The app this module measures and profiles.
    targetProjectPath = ":app"
}

kotlin {
    jvmToolchain(17)
}

// Generating the profile and running the benchmarks need a device or emulator; neither runs in the
// normal build or in CI. See apps/android/README.md ("Performance: baseline profile and benchmarks").
baselineProfile {
    useConnectedDevices = true
}

dependencies {
    implementation(libs.androidx.test.ext.junit)
    implementation(libs.junit)
    implementation(libs.androidx.test.uiautomator)
    implementation(libs.androidx.benchmark.macro.junit4)
}
