package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Nekko Agent's service, managed from the phone (#2059, the iPhone's #2057;
 * spec/desktop/service-management.md). Version 1 of the `service:*` contract: six channels, all
 * with no arguments. Status and update state are Read; check, download, restart and install are
 * Change (signed), and restart and install also need step-up when the computer asks for it. The
 * computer refuses all but `service:status` unless *Manage service from phone* is on there, a
 * setting no phone can change. Nothing here can restart the operating system.
 */
object ServiceChannels {
    const val STATUS = "service:status"
    const val UPDATE_STATE = "service:updateState"
    const val UPDATE_CHECK = "service:updateCheck"
    const val UPDATE_DOWNLOAD = "service:updateDownload"
    const val RESTART = "service:restart"
    const val UPDATE_INSTALL = "service:updateInstall"

    val ALL = listOf(STATUS, UPDATE_STATE, UPDATE_CHECK, UPDATE_DOWNLOAD, RESTART, UPDATE_INSTALL)
}

/** What the service section can ask for. Capabilities describe support, not permission. */
enum class ServiceAction(val wire: String, val channel: String) {
    RESTART("restart", ServiceChannels.RESTART),
    UPDATE_STATE("updateState", ServiceChannels.UPDATE_STATE),
    UPDATE_CHECK("updateCheck", ServiceChannels.UPDATE_CHECK),
    UPDATE_DOWNLOAD("updateDownload", ServiceChannels.UPDATE_DOWNLOAD),
    UPDATE_INSTALL("updateInstall", ServiceChannels.UPDATE_INSTALL),
    ;

    /** Restart and install interrupt chats and drop this phone: asked first, and step-up guarded. */
    val needsConfirmation: Boolean get() = this == RESTART || this == UPDATE_INSTALL

    /** Change class: signed with this phone's key. */
    val isChange: Boolean get() = this != UPDATE_STATE
}

/** `service:status`. An answer that isn't exactly version 1 with every capability is refused (null). */
data class ServiceStatus(
    val manageServiceFromPhone: Boolean,
    val capabilities: Map<ServiceAction, Capability>,
) {
    data class Capability(val supported: Boolean, val reason: String?)

    fun supports(a: ServiceAction): Boolean = capabilities[a]?.supported == true

    companion object {
        fun from(e: JsonElement?): ServiceStatus? {
            val o = e as? JsonObject ?: return null
            if ((o["protocolVersion"] as? JsonPrimitive)?.longOrNull != 1L) return null
            if ((o["agentRunning"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull != true) return null
            val enabled = (o["manageServiceFromPhone"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
            val caps = o["capabilities"] as? JsonObject ?: return null
            val parsed = ServiceAction.entries.associateWith { a ->
                val c = caps[a.wire] as? JsonObject ?: return null
                val supported = (c["supported"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
                Capability(supported, (c["reason"] as? JsonPrimitive)?.takeIf { it.isString }?.content)
            }
            return ServiceStatus(enabled, parsed)
        }
    }
}

/** The computer's updater (`UpdateInfo`), narrowed. An unknown state is refused (null), never guessed. */
data class ServiceUpdate(
    val state: State,
    val currentVersion: String,
    val version: String?,
    val percent: Double?,
    val message: String?,
) {
    enum class State(val wire: String) { IDLE("idle"), CHECKING("checking"), AVAILABLE("available"), DOWNLOADING("downloading"), DOWNLOADED("downloaded"), NONE("none"), ERROR("error") }

    val busy: Boolean get() = state == State.CHECKING || state == State.DOWNLOADING

    companion object {
        fun from(e: JsonElement?): ServiceUpdate? {
            val o = e as? JsonObject ?: return null
            fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val state = State.entries.firstOrNull { it.wire == str("state") } ?: return null
            val current = str("currentVersion") ?: return null
            if (str("notesUrl") == null) return null
            if (str("edition") !in setOf("desktop", "web")) return null
            val percent = (o["percent"] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }?.coerceIn(0.0, 100.0)
            return ServiceUpdate(state, current, str("version"), percent, str("message"))
        }
    }
}

/**
 * What the section says, as kinds the screen words in the phone's language. [detail] is the
 * computer's own words when it gave some (an updater message, a refusal's detail).
 */
data class ServiceNote(val kind: Kind, val detail: String? = null) {
    enum class Kind {
        // Why an action can't run now.
        OFFLINE, WAIT, RECONNECT_FIRST, UPDATE_HOST, REFRESH_FIRST, OPT_IN, DOWNLOAD_FIRST, CHECK_FIRST, UPDATER_BUSY,
        // An action the computer doesn't support, by its reason.
        CAP_SUPERVISOR, CAP_NATIVE_UPDATER, CAP_NOT_PACKAGED, CAP_FEED, CAP_PACKAGED_INSTALL, CAP_LOCAL_APPROVAL, CAP_LAYOUT, CAP_ALREADY_REQUESTED, CAP_OTHER,
        // What went wrong.
        CONNECTION_CHANGED, UNSUPPORTED_RESPONSE, UNREADABLE_UPDATE, UPDATER_FAILED, NOT_ACCEPTED, NOT_SUPPORTED_HERE,
        SERVICE_UNAVAILABLE, SERVICE_BUSY, NOT_READY, INVALID, HOST_TOO_OLD, NOT_CONFIRMED, OTHER,
        // An accepted restart or install: not proof it finished.
        RESTART_ACCEPTED, INSTALL_ACCEPTED,
    }

    companion object {
        /** An unsupported capability's reason, in kinds the screen can word. */
        fun capability(reason: String?): ServiceNote = ServiceNote(
            when (reason) {
                "supervisor-unavailable" -> Kind.CAP_SUPERVISOR
                "native-updater-unavailable" -> Kind.CAP_NATIVE_UPDATER
                "app-not-packaged" -> Kind.CAP_NOT_PACKAGED
                "update-feed-unavailable" -> Kind.CAP_FEED
                "packaged-install-required" -> Kind.CAP_PACKAGED_INSTALL
                "interactive-package-install", "interactive-admin-install" -> Kind.CAP_LOCAL_APPROVAL
                "install-layout-unsupported" -> Kind.CAP_LAYOUT
                "install-already-requested" -> Kind.CAP_ALREADY_REQUESTED
                else -> Kind.CAP_OTHER
            },
        )

        /**
         * The computer's `service-*:` errors, in kinds. Null for anything else (the repository's
         * own wording, e.g. a refusal from the phone gate, is shown as it is).
         */
        fun error(raw: String, discovery: Boolean = false): ServiceNote? {
            val lower = raw.lowercase()
            if (discovery && (lower.contains("channel-denied") || lower.contains("unknown channel") || lower.contains("unknown-channel"))) return ServiceNote(Kind.HOST_TOO_OLD)
            // The code may come wrapped ("Error: service-busy: …"): it is found wherever it starts.
            if (raw.contains("service-disabled:")) return ServiceNote(Kind.OPT_IN)
            for ((prefix, kind) in listOf(
                "service-unsupported:" to Kind.NOT_SUPPORTED_HERE,
                "service-unavailable:" to Kind.SERVICE_UNAVAILABLE,
                "service-busy:" to Kind.SERVICE_BUSY,
                "service-not-ready:" to Kind.NOT_READY,
                "service-invalid:" to Kind.INVALID,
            )) {
                val at = raw.indexOf(prefix)
                if (at >= 0) return ServiceNote(kind, raw.substring(at + prefix.length).trim().ifEmpty { null })
            }
            return null
        }
    }
}
