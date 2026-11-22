package com.nekko.protocol

import java.net.URI
import java.net.URLEncoder
import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Services this phone connects to itself (#2109, the iPhone's decision 0058): a git provider for
 * the Pull requests screen, and the project-management tools the person works in. As with the
 * phone's own model providers, the token is kept in this phone's Keystore and sent only to that
 * service, over https. A computer's connectors are its own: none of these is sent to a computer,
 * the relay or Nekko Cloud, and a phone still can't change a computer's.
 */
object PhoneConnectors {
    enum class Category { GIT, TASKS }

    /** A setting a kind asks for besides its token. [isUrl]: the service's own address, https only. */
    data class Field(val id: String, val label: String, val placeholder: String, val isUrl: Boolean = false, val defaultValue: String? = null)

    data class Kind(
        val id: String,
        val label: String,
        val category: Category,
        /** What the secret is called on this kind. */
        val tokenName: String,
        /** A line under the form: where the token comes from. */
        val hint: String,
        val fields: List<Field> = emptyList(),
    ) {
        val listsPullRequests: Boolean get() = category == Category.GIT
    }

    /** In the order the Connectors page lists them; ids match the desktop's connector kinds. */
    val kinds = listOf(
        Kind("github", "GitHub", Category.GIT, "Personal access token",
            "A token from github.com → Settings → Developer settings. Fine-grained with read access to pull requests, or classic with repo.",
            listOf(Field("api", "API address", "https://api.github.com", isUrl = true, defaultValue = "https://api.github.com"))),
        Kind("gitlab", "GitLab", Category.GIT, "Personal access token",
            "A token with read_api, from GitLab → Preferences → Access tokens. gitlab.com or your own instance.",
            listOf(Field("site", "Instance", "https://gitlab.com", isUrl = true, defaultValue = "https://gitlab.com"))),
        Kind("bitbucket", "Bitbucket", Category.GIT, "API token",
            "An Atlassian API token with Bitbucket read scopes, and the email of your Atlassian account.",
            listOf(Field("email", "Email", "you@example.com"))),
        Kind("linear", "Linear", Category.TASKS, "API key", "A personal API key from Linear → Settings → Security & access."),
        Kind("jira", "Jira", Category.TASKS, "API token",
            "An API token from id.atlassian.com → Security, your site, and the email you sign in with.",
            listOf(Field("site", "Site", "https://your-team.atlassian.net", isUrl = true), Field("email", "Email", "you@example.com"))),
        Kind("floop", "Floop", Category.TASKS, "API token", "Your team’s Floop server and an API token from it.",
            listOf(Field("url", "Server", "https://floop.example.com", isUrl = true))),
        Kind("asana", "Asana", Category.TASKS, "Personal access token", "A personal access token from Asana’s developer console."),
        Kind("clickup", "ClickUp", Category.TASKS, "API token", "Your personal API token from ClickUp → Settings → Apps."),
        Kind("trello", "Trello", Category.TASKS, "Token", "Your Trello API key and a token you generate from it at trello.com/power-ups/admin.",
            listOf(Field("key", "API key", "Trello API key"))),
        Kind("todoist", "Todoist", Category.TASKS, "API token", "Your API token from Todoist → Settings → Integrations → Developer."),
    )

    fun kind(id: String): Kind? = kinds.firstOrNull { it.id == id }

    /** Where a connector's token is kept in the Keystore-sealed store. */
    fun tokenSlot(kind: String) = "phone.connector.token.$kind"

    /** A connector as the Connect sheet made it, checked. The token is kept apart. */
    fun make(kindId: String, token: String, settings: Map<String, String>, at: Long): PhoneConnector {
        val kind = requireNotNull(kind(kindId)) { "This service can’t be connected on this phone." }
        require(token.isNotBlank()) { "Paste the token." }
        // A header value: printable ASCII only, so it can't add headers of its own.
        require(token.trim().all { it.code in 32..126 }) { "The token must contain only printable ASCII." }
        val out = LinkedHashMap<String, String>()
        for (f in kind.fields) {
            var v = settings[f.id]?.trim().orEmpty()
            if (v.isEmpty()) f.defaultValue?.let { v = it }
            require(v.isNotEmpty()) { "Fill in ${f.label}." }
            require(v.none { it.isISOControl() }) { "${f.label} has a character it can’t hold." }
            if (f.isUrl) {
                v = v.trimEnd('/')
                val u = runCatching { URI(v) }.getOrNull()
                require(u != null && u.scheme == "https" && !u.host.isNullOrEmpty() && u.rawUserInfo == null && u.rawQuery == null && u.rawFragment == null && ' ' !in v) {
                    "${f.label} must be a full https:// address."
                }
            }
            out[f.id] = v
        }
        return PhoneConnector(kind.id, out, at)
    }

    private fun basic(user: String, token: String) = "Basic " + Base64.getEncoder().encodeToString("$user:$token".toByteArray())

    fun query(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20").replace("%7E", "~").replace("*", "%2A")

    /** The headers every call to this connector carries. */
    fun headers(c: PhoneConnector, token: String): Map<String, String> = when (c.kind) {
        "github" -> mapOf("Authorization" to "Bearer $token", "Accept" to "application/vnd.github+json", "X-GitHub-Api-Version" to "2022-11-28")
        "gitlab" -> mapOf("PRIVATE-TOKEN" to token, "Accept" to "application/json")
        "bitbucket", "jira" -> mapOf("Authorization" to basic(c.settings["email"].orEmpty(), token), "Accept" to "application/json")
        "linear" -> mapOf("Authorization" to token, "Content-Type" to "application/json")
        "clickup" -> mapOf("Authorization" to token, "Accept" to "application/json")
        "trello" -> mapOf("Accept" to "application/json")
        else -> mapOf("Authorization" to "Bearer $token", "Accept" to "application/json")
    }

    /** Connect's check: a real call that answers with who the token belongs to. */
    fun whoAmI(c: PhoneConnector, token: String): PhoneRequest {
        val h = headers(c, token)
        val s = c.settings
        fun get(url: String) = PhoneRequest(url, h, method = "GET")
        return when (c.kind) {
            "github" -> get("${s["api"] ?: "https://api.github.com"}/user")
            "gitlab" -> get("${s["site"] ?: "https://gitlab.com"}/api/v4/user")
            "bitbucket" -> get("https://api.bitbucket.org/2.0/user")
            "linear" -> PhoneRequest("https://api.linear.app/graphql", h, buildJsonObject { put("query", "{ viewer { name email } }") })
            "jira" -> get("${s["site"].orEmpty()}/rest/api/3/myself")
            "floop" -> get("${s["url"].orEmpty()}/api/v1/items?assignee=me&open=true&limit=1")
            "asana" -> get("https://app.asana.com/api/1.0/users/me")
            "clickup" -> get("https://api.clickup.com/api/v2/user")
            "trello" -> get("https://api.trello.com/1/members/me?fields=username,fullName&key=${query(s["key"].orEmpty())}&token=${query(token)}")
            else -> get("https://api.todoist.com/api/v1/tasks?limit=1")
        }
    }

    private fun parse(body: String): JsonElement? = if (body.length > 2_000_000) null else runCatching { Json.parseToJsonElement(body) }.getOrNull()
    private fun JsonElement?.at(vararg path: String): JsonElement? = path.fold(this) { v, k -> (v as? JsonObject)?.get(k) }
    private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** The account name in a `whoAmI` answer, or null where the service doesn't say. */
    fun account(kind: String, body: String): String? {
        val v = parse(body) ?: return null
        val name = when (kind) {
            "github", "gitlab" -> v.at("login").text() ?: v.at("username").text()
            "bitbucket" -> v.at("username").text() ?: v.at("nickname").text() ?: v.at("display_name").text()
            "linear" -> v.at("data", "viewer", "name").text() ?: v.at("data", "viewer", "email").text()
            "jira" -> v.at("displayName").text() ?: v.at("emailAddress").text()
            "asana" -> v.at("data", "name").text()
            "clickup" -> v.at("user", "username").text() ?: v.at("user", "email").text()
            "trello" -> v.at("username").text() ?: v.at("fullName").text()
            else -> null
        }
        return name?.takeIf { it.isNotEmpty() }
    }

    /** The id a service lists a user's pull requests by (GitLab's username, Bitbucket's uuid). */
    fun userId(kind: String, body: String): String? {
        val v = parse(body) ?: return null
        return when (kind) {
            "github" -> v.at("login").text()
            "gitlab" -> v.at("username").text()
            "bitbucket" -> v.at("uuid").text()
            else -> null
        }
    }

    /** Linear answers 200 with `errors` for a bad key: its first message, or null. */
    fun graphQLRefusal(body: String): String? {
        val first = (parse(body).at("errors") as? JsonArray)?.firstOrNull() ?: return null
        return first.at("message").text() ?: ""
    }

    /** What a failed answer says, in the service's words where it has some (cut short: never a body dump). */
    fun failure(label: String, status: Int, body: String): String {
        val v = parse(body)
        val message = listOfNotNull(
            v.at("message").text(), v.at("error_description").text(), v.at("error", "message").text(), v.at("error").text(),
            (v.at("errors") as? JsonArray)?.firstOrNull().at("message").text(), ((v.at("errorMessages") as? JsonArray)?.firstOrNull()).text(),
        ).firstOrNull()?.take(200)
        val said = message?.let { ": $it" } ?: ""
        return when (status) {
            401, 403 -> "$label turned the token down ($status)$said"
            404 -> "$label doesn’t know that address (404)$said"
            429 -> "$label is rate limiting this token (429)$said"
            else -> "$label answered $status$said"
        }
    }
}

/** A service this phone is connected to. Holds no secret: the token is in the Keystore-sealed store. */
@Serializable
data class PhoneConnector(
    val kind: String,
    /** The kind's fields (address, email, Trello's key): never the token. */
    val settings: Map<String, String> = emptyMap(),
    val connectedAt: Long,
    /** Who the token signed in as, when the service said. */
    val account: String? = null,
    /** The id the service lists this user's pull requests by, when it needs one. */
    val userId: String? = null,
) {
    val label: String get() = PhoneConnectors.kind(kind)?.label ?: kind
    val category: PhoneConnectors.Category get() = PhoneConnectors.kind(kind)?.category ?: PhoneConnectors.Category.TASKS
}

/** What the phone keeps of its connectors: the list and the git provider picked (never a token). */
@Serializable
data class PhoneConnectorList(val connectors: List<PhoneConnector> = emptyList(), val selectedGit: String? = null)
