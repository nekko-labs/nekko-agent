plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.nekko.android"
    // Current AndroidX (core 1.19, Compose 1.12, lifecycle 2.11) requires compiling
    // against API 37.2. targetSdk stays 36, so runtime behaviour is unchanged.
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "com.nekko.native.android"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        // BuildConfig.DEBUG: the relay hint knows debug builds allow ws://localhost (adb reverse).
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    // Mermaid for chat diagrams (MM-4): the desktop's and the iPhone's bundled copy, pinned by
    // scripts/vendor-mermaid.mjs, packaged as is (mermaid.min.js, pin.json, its LICENSE).
    sourceSets["main"].assets.directories += "../../../vendor/mermaid"

    // The computer's log redaction cases, checked on a device too: Android's
    // regex (ICU) is not the JVM's the unit tests run on (LogShareDeviceTest).
    sourceSets["androidTest"].assets.directories += "../../../crates/nekkod/tests/golden"
    // And the sealed box's vectors: the provider key is sealed by Android's own crypto providers (SealedBoxDeviceTest).
    sourceSets["androidTest"].assets.directories += "../../../crates/nekko-sync/tests/golden"
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":protocol"))
    // OkHttpTransport's constructor exposes OkHttpClient, so the app needs it on its compile classpath.
    implementation(libs.okhttp)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.gms.code.scanner)
    // App lock: the system fingerprint / face / screen-lock prompt. BiometricPrompt needs a FragmentActivity.
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.fragment.ktx)
    // Step-up (SK-7): security keys and passkeys through Credential Manager.
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.extended)
    // Folding phones: WindowInfoTracker's FoldingFeature and the window size class (Posture.from).
    implementation(libs.androidx.window)
    implementation(libs.compose.material3.adaptive)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)

    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.espresso.core)
    // Fakes a FoldingFeature (Fold-in, Fold-out, Surface Duo) for the pane tests.
    androidTestImplementation(libs.androidx.window.testing)
}
