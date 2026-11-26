package com.nekko.android.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.ui.Routes
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.screens.providerDrawable
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.ChatCard
import com.nekko.protocol.PhoneProviders

/**
 * Settings → Models on This phone (#2940, the iPhone's #2929): each of this phone's providers as an
 * avatar row with its mark that opens its page, and **Add a provider** with a plus, opening the
 * phone's providers where the provider buttons are (#2939).
 */
@Composable
fun PhoneModelsSection(deps: SettingsDeps) {
    val phone = deps.phone ?: return
    val s by phone.state.collectAsStateWithLifecycle()
    val p = Nekko.palette
    SectionHeader(stringResource(R.string.settings_models_on, stringResource(R.string.chats_this_phone)))
    Column(Modifier.padding(horizontal = 16.dp)) {
        s.providers.forEach { provider ->
            val error = s.errors[provider.id]
            AvatarRow(
                title = provider.label,
                detail = error ?: if (provider.enabled) PhoneProviders.kind(provider.kind)?.label else stringResource(R.string.settings_phone_provider_off),
                dim = !provider.enabled,
                detailColor = if (error != null) p.danger else null,
                modifier = Modifier.testTag("settings.phoneProvider.${provider.id}"),
                onClick = { deps.open(Routes.phoneProvider(provider.id)) },
                avatar = {
                    val mark = providerDrawable(ChatCard.providerMark(provider.kind, null))
                    if (mark != null) Icon(painterResource(mark), contentDescription = null, tint = p.ink, modifier = Modifier.size(20.dp))
                    else Icon(Icons.Outlined.Key, contentDescription = null, tint = p.ink, modifier = Modifier.size(20.dp))
                },
            )
        }
        PlusRow(stringResource(R.string.settings_add_provider), Modifier.testTag("settings.addProvider")) { deps.open(Routes.phoneProviders()) }
    }
}
