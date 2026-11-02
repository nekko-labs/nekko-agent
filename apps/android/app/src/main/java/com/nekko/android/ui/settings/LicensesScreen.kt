package com.nekko.android.ui.settings

import androidx.compose.ui.res.stringResource
import androidx.annotation.RawRes
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.theme.Nekko

/** Libraries shipped under one license, with that license's full text when it is bundled. */
data class LicenseGroup(val license: String, val components: List<String>, @RawRes val text: Int?, val note: String? = null)

/**
 * What the release APK contains (`./gradlew :app:dependencies --configuration releaseRuntimeClasspath`),
 * grouped by license. Hand-kept on purpose: a generator plugin would be a new build dependency
 * for a list that changes rarely. Update it when a library is added.
 */
val OpenSourceLicenses: List<LicenseGroup> = listOf(
    LicenseGroup("MIT License", listOf("Nekko Agent (this app), © 2026 Nekko Labs"), R.raw.license_nekko_mit),
    LicenseGroup(
        "Apache License 2.0",
        listOf(
            "AndroidX: Activity, Annotation, Core, Lifecycle, Navigation, SavedState, Startup and their dependencies",
            "Jetpack Compose: Runtime, UI, Foundation, Animation, Material 3, Material Icons",
            "Kotlin standard library, kotlinx.coroutines, kotlinx.serialization (JetBrains)",
            "JetBrains annotations, JSpecify, javax.inject",
            "OkHttp and Okio (Square)",
            "Guava ListenableFuture",
            "Firebase components and encoders, Google Data Transport (dependencies of the code scanner)",
        ),
        R.raw.license_apache_2_0,
    ),
    LicenseGroup(
        "Google Play services and ML Kit terms",
        listOf("Google code scanner (play-services-code-scanner), ML Kit barcode scanning, Play services base"),
        text = null,
        note = "Not open source. Used under the Android Software Development Kit License and the ML Kit Terms of Service: developers.google.com/ml-kit/terms",
    ),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LicensesScreen(onBack: () -> Unit) {
    val p = Nekko.palette
    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_licenses)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.settings_back)) }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            OpenSourceLicenses.forEach { LicenseCard(it) }
            Spacer(Modifier.size(32.dp))
        }
    }
}

@Composable
private fun LicenseCard(group: LicenseGroup) {
    val p = Nekko.palette
    var open by rememberSaveable(group.license) { mutableStateOf(false) }
    SectionHeader(group.license)
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            group.components.forEach { Text(it, style = MaterialTheme.typography.bodyMedium, color = p.ink) }
            group.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
            if (group.text != null) {
                TextButton(onClick = { open = !open }) { Text(if (open) stringResource(R.string.settings_hide_license) else stringResource(R.string.settings_show_license)) }
                if (open) LicenseText(group.text)
            }
        }
    }
}

@Composable
private fun LicenseText(@RawRes res: Int) {
    val resources = LocalResources.current
    val text = remember(res) { resources.openRawResource(res).bufferedReader().use { it.readText() }.trim() }
    SelectionContainer {
        Text(text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = Nekko.palette.inkSoft)
    }
}
