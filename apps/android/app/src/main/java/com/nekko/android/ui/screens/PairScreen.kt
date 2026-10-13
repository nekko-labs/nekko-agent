package com.nekko.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.google.mlkit.common.MlKitException
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.nekko.android.data.ComputersRepository
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Pairing
import com.nekko.protocol.PairingLink
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

private const val NOT_A_LINK = "That isn’t a pairing link. On your computer: Settings → Remote access → Pair a device."

/**
 * Pair with a computer: scan the QR from Settings → Remote access, or paste the
 * link. A `nekko-agent-pair:` link opened from outside the app lands here
 * pre-filled and asks before pairing.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairScreen(
    repo: ComputersRepository,
    initialLink: String?,
    onBack: () -> Unit,
    onPaired: () -> Unit,
) {
    val p = Nekko.palette
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var text by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<PairingLink?>(null) }
    // A link from outside the app is only a proposal until the user confirms it.
    var proposed by remember(initialLink) {
        mutableStateOf(initialLink?.let { Pairing.parse(it) })
    }
    LaunchedEffect(initialLink) {
        // An unreadable link from outside: show it so the user can see what came in.
        if (initialLink != null && Pairing.parse(initialLink) == null) {
            text = initialLink
            error = NOT_A_LINK
        }
    }

    val commit: (String) -> Unit = commit@{ raw ->
        if (busy != null) return@commit
        val link = Pairing.parse(raw)
        if (link == null) {
            error = NOT_A_LINK
            return@commit
        }
        error = null
        proposed = null
        busy = link
        scope.launch {
            try {
                repo.pair(link)
                onPaired()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                busy = null
                error = e.message?.takeIf { it.isNotBlank() } ?: "Pairing failed. Try a fresh QR."
            }
        }
    }

    val scan = {
        error = null
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build()
        GmsBarcodeScanning.getClient(context, options).startScan()
            .addOnSuccessListener { code ->
                val raw = code.rawValue.orEmpty()
                text = raw
                commit(raw)
            }
            .addOnFailureListener { e ->
                error = if (e is MlKitException && e.errorCode == MlKitException.UNAVAILABLE) {
                    "The QR scanner isn’t ready yet: Google Play services is still downloading it. Try again in a minute, or paste the link below."
                } else {
                    "Couldn’t open the QR scanner. Paste the link below instead."
                }
            }
        Unit
    }

    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text("Pair a computer") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            val pending = busy
            val offer = proposed
            when {
                pending != null -> NCard {
                    Column(
                        Modifier.fillMaxWidth().padding(vertical = 16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(Icons.Filled.Lock, contentDescription = null, tint = p.accent, modifier = Modifier.size(28.dp))
                        Text("Pairing securely…", style = MaterialTheme.typography.titleMedium, color = p.ink)
                        Text(
                            "Deriving the encryption key and saying hello to your computer through ${Pairing.relayHost(pending.relayUrl)}.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = p.inkSoft,
                            textAlign = TextAlign.Center,
                        )
                        CircularProgressIndicator(color = p.accent, modifier = Modifier.size(24.dp))
                    }
                }
                offer != null -> NCard {
                    Text("Pair with this computer?", style = MaterialTheme.typography.titleMedium, color = p.ink)
                    Text(
                        "A pairing link was opened. This phone will connect to your computer through ${Pairing.relayHost(offer.relayUrl)}, end-to-end encrypted. Only continue if you just chose “Pair a device” on your own computer.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = p.inkSoft,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = { proposed = null },
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        ) { Text("Cancel") }
                        Button(
                            onClick = { commit(initialLink.orEmpty()) },
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        ) { Text("Pair") }
                    }
                }
                else -> {
                    Button(onClick = scan, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                        Icon(Icons.Filled.QrCodeScanner, contentDescription = null, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.size(8.dp))
                        Text("Scan QR code")
                    }
                    Text(
                        "On your computer: Nekko Agent → Settings → Remote access → Pair a device. Or copy the link and paste it here:",
                        style = MaterialTheme.typography.bodyMedium,
                        color = p.inkSoft,
                    )
                    OutlinedTextField(
                        value = text,
                        onValueChange = {
                            text = it
                            error = null
                        },
                        label = { Text("Pairing link") },
                        placeholder = { Text("nekko-agent-pair:?relay=…") },
                        textStyle = Nekko.mono.copy(color = p.ink),
                        isError = error != null,
                        minLines = 3,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = {
                                scope.launch {
                                    val v = clipboard.getClipEntry()?.clipData?.takeIf { it.itemCount > 0 }
                                        ?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
                                    text = v
                                    error = null
                                    if (Pairing.parse(v) != null) commit(v)
                                }
                            },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) {
                            Icon(Icons.Filled.ContentPaste, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(8.dp))
                            Text("Paste")
                        }
                        Button(
                            onClick = { commit(text) },
                            enabled = text.isNotBlank(),
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        ) { Text("Pair") }
                    }
                }
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = p.danger) }
            if (busy == null) {
                Text(
                    "The link holds a one-time code (valid 10 minutes) and the key that encrypts everything between this phone and your computer. Treat it like a password.",
                    style = MaterialTheme.typography.bodySmall,
                    color = p.inkFaint,
                )
            }
        }
    }
}
