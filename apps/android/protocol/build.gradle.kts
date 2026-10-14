plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}

tasks.test {
    // The cross-language and live-relay checks are opt-in (see README); pass
    // their switches through so `NEKKO_ITEST=1 ./gradlew :protocol:test` works.
    environment("NEKKO_REPO_ROOT", rootDir.resolve("../..").canonicalPath)
    listOf("NEKKO_ITEST", "NEKKO_E2E_OUT").forEach { key ->
        System.getenv(key)?.let { environment(key, it) }
    }
    // Those runs have side effects the build cache can't replay: a live relay
    // test, and the frames file a later CI step reads. A cached result would
    // skip both and still pass, so they always run.
    val sideEffects = listOf("NEKKO_ITEST", "NEKKO_E2E_OUT").any { System.getenv(it) != null }
    if (sideEffects) {
        outputs.cacheIf { false }
        outputs.upToDateWhen { false }
    }
    testLogging {
        events("failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
