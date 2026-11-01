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
    // LiveCardTest reads the card rules' shared fixture in place: a change there reruns the tests.
    inputs.file(rootDir.resolve("../../packages/shared/fixtures/live-card.json")).withPropertyName("liveCardFixture")
    listOf("NEKKO_ITEST", "NEKKO_E2E_OUT").forEach { key ->
        System.getenv(key)?.let { environment(key, it) }
    }
    // These checks write files or reach live processes as a side effect, which a
    // build-cache hit would skip: CI then found no kotlin-frames.json for the
    // node step. Never take the task from the cache while either switch is on.
    if (System.getenv("NEKKO_E2E_OUT") != null || System.getenv("NEKKO_ITEST") == "1") {
        outputs.cacheIf { false }
        outputs.upToDateWhen { false }
    }
    testLogging {
        events("failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
