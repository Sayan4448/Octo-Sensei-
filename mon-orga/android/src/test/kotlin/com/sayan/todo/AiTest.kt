package com.sayan.todo

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.net.ServerSocket

@RunWith(RobolectricTestRunner::class)
class AiTest {
    @Test fun `plain http only on the local network, https anywhere`() {
        listOf("https://api.openai.com/v1/models", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            "http://localhost:11434/v1/models", "http://127.0.0.1:1234/v1", "http://192.168.1.20:11434/v1/chat/completions",
            "http://10.0.0.5:8080/v1", "http://172.20.1.2/v1", "http://mon-pc.local:11434/v1").forEach { assertTrue(it, Ai.allowed(it)) }
        listOf("http://api.openai.com/v1", "http://8.8.8.8/v1", "http://192.168.1.20.evil.com/v1", "http://172.32.0.1/v1",
            "ftp://192.168.1.2/", "javascript:alert(1)", "", "https://").forEach { assertFalse(it, Ai.allowed(it)) }
        assertEquals("address", JSONObject(Ai.call("http://example.com/v1/models", "k", null)).getString("error"))
    }

    @Test fun `the request carries the key and the body, the answer comes back as is`() {
        val port = ServerSocket(0).use { it.localPort }
        var seen = ""
        val server = object : NanoHTTPD("127.0.0.1", port) {
            override fun serve(s: IHTTPSession): Response {
                val files = HashMap<String, String>(); if (s.method == Method.POST) s.parseBody(files)
                seen = s.method.name + " " + s.uri + " " + s.headers["authorization"] + " " + files["postData"].orEmpty()
                return if (s.uri.endsWith("/models")) newFixedLengthResponse(Response.Status.UNAUTHORIZED, "application/json", """{"error":{"message":"bad key"}}""")
                else newFixedLengthResponse(Response.Status.OK, "application/json", """{"choices":[{"message":{"content":"Salut"}}]}""")
            }
        }.also { it.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false) }
        try {
            val r = JSONObject(Ai.call("http://127.0.0.1:$port/v1/chat/completions", "sk-1", """{"model":"m"}"""))
            assertEquals(200, r.getInt("status"))
            assertEquals("Salut", JSONObject(r.getString("body")).getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content"))
            assertEquals("""POST /v1/chat/completions Bearer sk-1 {"model":"m"}""", seen)
            val e = JSONObject(Ai.call("http://127.0.0.1:$port/v1/models", null, null))
            assertEquals(401, e.getInt("status")) // refused: the page says "key refused"
            assertEquals("GET /v1/models null ", seen) // no key, no Authorization header
        } finally { server.stop() }
        assertEquals("network", JSONObject(Ai.call("http://127.0.0.1:$port/v1/models", null, null, 2000)).getString("error")) // nothing listens
    }
}
