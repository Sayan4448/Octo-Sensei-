package com.sayan.todo

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL

@RunWith(RobolectricTestRunner::class)
class SyncTest {
    private val app = RuntimeEnvironment.getApplication()
    private lateinit var server: SyncServer
    private var port = 0

    @Before fun start() {
        port = ServerSocket(0).use { it.localPort }
        server = SyncServer(app, "123456", port).also { it.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false) }
    }

    @After fun stop() = server.stop()

    private fun call(path: String, body: String? = null): Pair<Int, String> {
        val c = URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection
        if (body != null) {
            c.requestMethod = "POST"; c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8") // what the PC app sends
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        val code = c.responseCode
        return code to ((if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText().orEmpty())
    }

    @Test fun pingIsOpenButDataNeedsTheCode() {
        assertTrue(call("/api/ping").second.contains("mon-orga"))
        assertEquals(401, call("/api/state").first)
        assertEquals(401, call("/api/state?k=000000").first)
        assertEquals(200, call("/api/state?k=123456").first)
    }

    @Test fun syncMergesBothWays() {
        app.prefs().edit().putString(STATE_KEY, """{"tasks":[{"id":"a","text":"Téléphone","updatedAt":1},{"id":"b","text":"Seulement ici","updatedAt":1}]}""").commit()
        val (code, body) = call("/api/sync?k=123456", """{"tasks":[{"id":"a","text":"Modifiée sur le PC é","updatedAt":2},{"id":"c","text":"Nouvelle","updatedAt":3}]}""")
        assertEquals(200, code)
        val merged = items(JSONObject(body), "tasks").associate { it.getString("id") to it.getString("text") }
        assertEquals(mapOf("a" to "Modifiée sur le PC é", "b" to "Seulement ici", "c" to "Nouvelle"), merged)
        assertEquals(merged.keys, items(loadDoc(app.prefs()), "tasks").map { it.getString("id") }.toSet())
    }

    @Test fun servesTheSameInterfaceAndAsksForTheCode() {
        assertTrue(call("/?k=123456").second.contains("app.js"))
        assertEquals(200, call("/style.css").first)
        assertTrue(call("/").second.contains("6"))
        assertTrue(call("/../secret").first in listOf(403, 404)) // nothing outside the interface files
    }

    @Test fun tooManyWrongCodesBlockForAMinute() {
        repeat(10) { call("/api/state?k=111111") }
        assertEquals(401, call("/api/state?k=123456").first)
    }
}
