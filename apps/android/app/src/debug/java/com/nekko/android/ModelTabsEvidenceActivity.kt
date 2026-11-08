package com.nekko.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nekko.android.data.ModelGroup
import com.nekko.android.data.ModelPick
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.screens.ModelList
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.PublicProvider

/**
 * The New chat model picker over one cloud provider and one local model server, as a
 * computer would list them. Offline renderer evidence: debug source set only, no
 * pairing or relay calls.
 */
class ModelTabsEvidenceActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val claude = PublicProvider("anthropic", "anthropic", "Claude API", true)
        val ollama = PublicProvider("ollama", "ollama", "Ollama", true)
        val groups = listOf(
            ModelGroup(claude, listOf(ModelInfo("claude-opus-5-5", "anthropic", "Claude Opus 5.5", false), ModelInfo("claude-sonnet-5-5", "anthropic", "Claude Sonnet 5.5", false))),
            ModelGroup(ollama, listOf(ModelInfo("qwen3:8b", "ollama", "Qwen3 8B", true))),
        )
        setContent {
            NekkoTheme(dark = false) {
                var pick by remember { mutableStateOf<ModelPick?>(ModelPick("anthropic", "claude-opus-5-5")) }
                var query by remember { mutableStateOf("") }
                Column(Modifier.fillMaxSize().background(Nekko.palette.paper).systemBarsPadding().padding(16.dp)) {
                    Text("New chat", style = MaterialTheme.typography.titleLarge, color = Nekko.palette.ink, modifier = Modifier.padding(bottom = 16.dp))
                    NCard {
                        ModelList(
                            groups = groups,
                            favorites = listOf("ollama::qwen3:8b"),
                            query = query,
                            onQuery = { query = it },
                            selected = pick,
                            onPick = { pick = it },
                            onRetry = {},
                        )
                    }
                }
            }
        }
    }
}
