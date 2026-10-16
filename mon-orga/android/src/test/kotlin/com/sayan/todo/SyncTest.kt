package com.sayan.todo

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL
import kotlin.math.abs

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

    private fun call(path: String, body: String? = null, p: Int = port): Pair<Int, String> = open(path, body, p).let { c ->
        val code = c.responseCode
        code to ((if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText().orEmpty())
    }

    private fun open(path: String, body: String? = null, p: Int = port): HttpURLConnection {
        val c = URL("http://127.0.0.1:$p$path").openConnection() as HttpURLConnection
        if (body != null) {
            c.requestMethod = "POST"; c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8") // what the PC app sends
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        return c
    }

    private val key get() = KEY
    private fun request(nonce: String, doc: JSONObject? = null, since: Long = 0, ts: Long = System.currentTimeMillis()) =
        JSONObject().put("ts", ts).put("nonce", nonce).put("since", since).put("doc", doc ?: JSONObject.NULL)
    private fun v2(req: JSONObject, k: javax.crypto.spec.SecretKeySpec = key) = call("/api/v2/sync", seal(k, req.toString()).toString())
    private fun answer(body: String) = JSONObject(unseal(key, body)!!)

    // The same vector is checked by the PC app's tests (pc/test): same key, same cipher text.
    @Test fun sealedLikeThePcApp() {
        val plain = """{"ts":1,"nonce":"n","since":0,"doc":null}"""
        val sealed = seal(syncKey("123456"), plain, ByteArray(12) { it.toByte() })
        assertEquals(2, sealed.getInt("v"))
        assertEquals("AAECAwQFBgcICQoL", sealed.getString("iv"))
        assertEquals("k2N/cPtqBlp8j++2mW4D0hFvwvpheU13FXyhu1hauM0re0F7cdSbkJIYKu8uOWLVnO6pibbPfzbM", sealed.getString("data"))
        assertEquals(plain, unseal(key, sealed.toString()))
        val fresh = seal(key, "é")
        assertEquals("é", unseal(key, fresh.toString()))
        assertNotEquals(fresh.getString("iv"), seal(key, "é").getString("iv"))
        assertNull(unseal(syncKey("654321"), sealed.toString())) // another code
        val data = sealed.getString("data")
        assertNull(unseal(key, JSONObject(sealed.toString()).put("data", (if (data[0] == 'A') "B" else "A") + data.drop(1)).toString())) // changed on the way
    }

    @Test fun v2SyncMergesAndAnswersSealed() {
        app.prefs().edit().putString(STATE_KEY, """{"tasks":[{"id":"a","text":"Téléphone","updatedAt":1}]}""").commit()
        val c = open("/api/v2/sync", seal(key, request("n1", JSONObject("""{"tasks":[{"id":"b","text":"PC é","updatedAt":2}]}""")).toString()).toString())
        assertEquals(200, c.responseCode)
        assertTrue(c.contentType.startsWith("application/json"))
        val merged = answer(c.inputStream.bufferedReader().readText())
        assertTrue(abs(merged.getLong("ts") - System.currentTimeMillis()) < 60_000)
        assertEquals(mapOf("a" to "Téléphone", "b" to "PC é"), items(merged.getJSONObject("doc"), "tasks").associate { it.getString("id") to it.getString("text") })
        assertEquals(setOf("a", "b"), items(loadDoc(app.prefs()), "tasks").map { it.getString("id") }.toSet())
        val (code, body) = v2(request("n2")) // no doc: what the phone has
        assertEquals(200, code)
        assertEquals(2, items(answer(body).getJSONObject("doc"), "tasks").size)
    }

    @Test fun v2KeepsBothTextsOfANoteEditedOnBothSides() {
        app.prefs().edit().putString(STATE_KEY, """{"notes":[{"id":"n","text":"Téléphone","updatedAt":200}]}""").commit()
        val (code, body) = v2(request("r5", JSONObject("""{"notes":[{"id":"n","text":"PC","updatedAt":300}]}"""), since = 100))
        assertEquals(200, code)
        val notes = items(answer(body).getJSONObject("doc"), "notes").map { it.getString("id") to it.getString("text") }
        assertEquals(listOf("n" to "PC", "n-c200" to "Téléphone"), notes)
        assertEquals(notes, items(loadDoc(app.prefs()), "notes").map { it.getString("id") to it.getString("text") })
    }

    @Test fun v2RefusesOtherCodesOldRequestsAndReplays() {
        assertEquals(401, v2(request("x"), syncKey("000000")).first)
        assertEquals(401, call("/api/v2/sync", "not json").first)
        assertEquals(401, v2(request("old", ts = System.currentTimeMillis() - 130_000)).first)
        assertEquals(401, v2(request("ahead", ts = System.currentTimeMillis() + 130_000)).first)
        assertEquals(401, v2(request("")).first) // a nonce is required
        val once = seal(key, request("once").toString()).toString()
        assertEquals(200, call("/api/v2/sync", once).first)
        assertEquals(401, call("/api/v2/sync", once).first) // played again
        assertEquals(200, v2(request("other")).first)
    }

    @Test fun v2WrongCodesCountButAReplayDoesNotClearTheCount() {
        val recorded = seal(key, request("rec").toString()).toString()
        assertEquals(200, call("/api/v2/sync", recorded).first)
        repeat(5) { call("/api/state?k=111111") }
        assertEquals(401, call("/api/v2/sync", recorded).first) // someone plays a recorded request again: refused, count kept
        val wrong = seal(syncKey("111111"), request("w").toString()).toString()
        repeat(5) { call("/api/v2/sync", wrong) }
        assertEquals(401, call("/api/state?k=123456").first) // 10 wrong: blocked
        assertEquals(401, v2(request("late")).first) // v2 too
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

    @Test fun pingNamesThePhoneOnlyWithTheCodeAndThereIsNoCors() {
        val open = JSONObject(call("/api/ping").second)
        assertTrue(open.getBoolean("ok"))
        assertEquals(2, open.getInt("v")) // the PC uses /api/v2/sync only with a phone that says so
        assertTrue(open.getLong("now") > 0) // and dates its requests on the phone's clock
        assertFalse(open.has("name"))
        assertTrue(JSONObject(call("/api/ping?k=123456").second).has("name"))
        assertNull(open("/api/state?k=123456").getHeaderField("Access-Control-Allow-Origin"))
    }

    @Test fun eachFurtherTenWrongCodesDoubleTheWait() {
        var now = System.currentTimeMillis()
        server.clock = { now }
        repeat(10) { call("/api/state?k=111111") }
        now += 61_000 // the first block lasts a minute, then 10 more wrong ones…
        repeat(10) { call("/api/state?k=111111") }
        now += 61_000
        assertEquals(401, call("/api/state?k=123456").first) // …block for two
        now += 60_000
        assertEquals(200, call("/api/state?k=123456").first)
    }

    @Test fun aNewCodeStopsTheOldOneAtOnce() {
        app.prefs().edit().putString("syncCode", "222222").commit()
        val p = ServerSocket(0).use { it.localPort }
        val live = SyncServer(app, port = p).also { it.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false) }
        try {
            assertEquals(200, call("/api/state?k=222222", p = p).first)
            val fresh = newSyncCode(app)
            assertEquals(401, call("/api/state?k=222222", p = p).first)
            assertEquals(200, call("/api/state?k=$fresh", p = p).first)
        } finally { live.stop() }
    }

    companion object {
        private val KEY by lazy { syncKey("123456") } // 100 000 rounds: made once
    }
}
