package com.sayan.todo

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

const val AI_KEY = "aiKey" // the assistant's API key: in the app's own storage, never in the settings, backups or exports

// The assistant's requests, to any service speaking the OpenAI chat API (Google AI Studio, OpenAI, Ollama, LM Studio…).
object Ai {
    // Plain http only to this device or the local network: an API key never crosses the internet unencrypted.
    // The same rule as aiAllowed in web/src/store.js.
    private val HTTPS = Regex("""^https://[^\s/?#]+""", RegexOption.IGNORE_CASE)
    private val LOCAL = Regex("""^http://(localhost|127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|\[::1]|[a-z0-9-]+\.local)(:\d{1,5})?([/?#]|$)""", RegexOption.IGNORE_CASE)
    fun allowed(url: String) = HTTPS.containsMatchIn(url) || LOCAL.containsMatchIn(url)

    // POST the body (GET without one), with the key. Never throws: {"status", "body"} or {"error"}.
    fun call(url: String, key: String?, body: String?, readTimeoutMs: Int = 180_000): String {
        if (!allowed(url)) return JSONObject().put("error", "address").toString()
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = 15_000; c.readTimeout = readTimeoutMs // a local AI on a slow PC takes its time
            c.setRequestProperty("Accept", "application/json")
            if (!key.isNullOrBlank()) c.setRequestProperty("Authorization", "Bearer $key")
            if (body != null) {
                c.requestMethod = "POST"; c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                c.outputStream.use { it.write(body.toByteArray()) }
            }
            val status = c.responseCode
            val text = (if (status < 400) c.inputStream else c.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            c.disconnect()
            JSONObject().put("status", status).put("body", text).toString()
        } catch (e: Exception) { // no network, refused, timeout, a bad address
            JSONObject().put("error", "network").put("detail", e.message.orEmpty()).toString()
        }
    }
}
