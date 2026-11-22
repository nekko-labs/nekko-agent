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
import com.nekko.protocol.ProviderAccount
import com.nekko.protocol.PublicProvider

/**
 * The New chat model picker over one Claude login with a personal plan and an
 * organization seat (#2488), as a computer would list them. Synthetic accounts,
 * debug source set only, no pairing or relay calls. Launch with
 * `--ez identity false` to see the same providers without `account`, as a
 * computer from before #2488 lists them.
 */
class AccountsEvidenceActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val identity = intent.getBooleanExtra("identity", true)
        fun account(scope: String, name: String, plan: String) =
            if (identity) ProviderAccount(signedIn = true, email = "alex@example.test", scope = scope, name = name, plan = plan) else null
        val personal = PublicProvider("personal", "claude-code", "Claude subscription", true, account("personal", "Personal", "max"))
        val acme = PublicProvider("acme", "claude-code", "Claude subscription · account-2", true, account("organization", "Acme Inc", "team"))
        val models = { id: String -> listOf(ModelInfo("opus", id, "Claude Opus", false), ModelInfo("sonnet", id, "Claude Sonnet", false)) }
        val groups = listOf(ModelGroup(personal, models("personal")), ModelGroup(acme, models("acme")))
        setContent {
            NekkoTheme(dark = false) {
                var pick by remember { mutableStateOf<ModelPick?>(ModelPick("personal", "opus")) }
                var query by remember { mutableStateOf("") }
                Column(Modifier.fillMaxSize().background(Nekko.palette.paper).systemBarsPadding().padding(16.dp)) {
                    Text("New chat", style = MaterialTheme.typography.titleLarge, color = Nekko.palette.ink, modifier = Modifier.padding(bottom = 16.dp))
                    NCard {
                        ModelList(
                            groups = groups,
                            favorites = listOf("acme::opus"),
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
