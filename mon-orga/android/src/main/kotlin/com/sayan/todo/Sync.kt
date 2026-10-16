package com.sayan.todo

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.IOException
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.SecureRandom

const val SYNC_PORT = 8080

// The 6-digit code every data request must carry (?k=...), so a neighbour on the same Wi-Fi cannot read the data.
fun syncCode(ctx: Context): String = ctx.prefs().getString("syncCode", null) ?: newSyncCode(ctx)

// A fresh code: the old one stops working at once (the server reads the code at every request).
fun newSyncCode(ctx: Context): String = (100000 + SecureRandom().nextInt(900000)).toString().also { ctx.prefs().edit().putString("syncCode", it).commit() }

// The phone's address on the local network (Wi-Fi first), or null without one.
fun localIp(): String? = runCatching {
    NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
        .flatMap { it.inetAddresses.toList() }
        .firstOrNull { it is Inet4Address && it.isSiteLocalAddress }?.hostAddress
}.getOrNull()

fun syncUrl(ctx: Context): String? = localIp()?.let { "http://$it:$SYNC_PORT/?k=${syncCode(ctx)}" }

fun syncInfo(ctx: Context): String = JSONObject().put("on", ctx.prefs().getBoolean("syncOn", false))
    .put("url", syncUrl(ctx) ?: JSONObject.NULL).put("code", syncCode(ctx)).toString()

// Small HTTP server for the PC: the same interface as the app (from the assets) and the data API.
// /api/ping answers without the code (the PC app finds the phone with it), the phone's name only with it; everything
// else that touches data needs it. No CORS: the PC app is not a browser, and the page the phone serves is same-origin.
// `code` is fixed for the tests; otherwise the current one is read at every request.
class SyncServer(private val ctx: Context, private val code: String? = null, port: Int = SYNC_PORT) : NanoHTTPD(port) {
    private var failures = 0
    private var lockouts = 0
    private var blockedUntil = 0L
    internal var clock: () -> Long = System::currentTimeMillis

    override fun serve(session: IHTTPSession): Response = noStore(
        try { route(session) } catch (e: Exception) { text(Response.Status.INTERNAL_ERROR, "Error") },
    )

    private fun route(s: IHTTPSession): Response {
        val uri = s.uri
        if (uri == "/api/ping") return json(JSONObject().put("app", "mon-orga").put("ok", true).apply { if (codeOk(s.parms["k"])) put("name", Build.MODEL) }.toString())
        val wantsData = uri.startsWith("/api/") || uri == "/" || uri == "/index.html"
        if (wantsData && !codeOk(s.parms["k"])) {
            return if (uri.startsWith("/api/")) text(Response.Status.UNAUTHORIZED, "Code incorrect") else html(CODE_PAGE)
        }
        val prefs = ctx.prefs()
        return when {
            uri == "/api/state" -> json(loadDoc(prefs).toString())
            uri == "/api/sync" && s.method == Method.POST -> {
                val body = HashMap<String, String>()
                s.parseBody(body)
                val merged = syncDoc(prefs, JSONObject(body["postData"] ?: "{}"))
                    ?: return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json", """{"error":"storage"}""")
                Reminders.edited(ctx); Widget.update(ctx)
                json(merged.toString())
            }
            uri.startsWith("/api/") -> text(Response.Status.NOT_FOUND, "")
            else -> asset(uri.trimStart('/').ifEmpty { "index.html" })
        }
    }

    // 10 wrong codes: refuse everything for a minute, then 2, 4… up to an hour for each further 10 (6 digits must not be guessable in a loop).
    @Synchronized private fun codeOk(k: String?): Boolean {
        val now = clock()
        if (now < blockedUntil) return false
        if (k == (code ?: syncCode(ctx))) { failures = 0; lockouts = 0; return true }
        if (k != null && ++failures >= 10) { failures = 0; blockedUntil = now + minOf(60L, 1L shl minOf(lockouts, 6)) * 60_000; lockouts++ }
        return false
    }

    private fun asset(name: String): Response {
        if (name.contains("..")) return text(Response.Status.FORBIDDEN, "")
        val mime = when (name.substringAfterLast('.')) {
            "html" -> "text/html; charset=utf-8"; "js" -> "text/javascript; charset=utf-8"; "css" -> "text/css; charset=utf-8"
            "svg" -> "image/svg+xml"; else -> "application/octet-stream"
        }
        return try { newChunkedResponse(Response.Status.OK, mime, ctx.assets.open(name)) } catch (e: IOException) { text(Response.Status.NOT_FOUND, "") }
    }

    private fun json(s: String) = newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", s)
    private fun text(status: Response.Status, s: String) = newFixedLengthResponse(status, "text/plain; charset=utf-8", s)
    private fun html(s: String) = newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", s)

    private fun noStore(r: Response) = r.apply { addHeader("Cache-Control", "no-store") }

    companion object {
        private val CODE_PAGE = """<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mon Orga</title><body style="font-family:system-ui,sans-serif;background:#FEF7FF;color:#1D1B20;display:grid;place-items:center;min-height:90vh;margin:0">
<form action="/" style="background:#F3EDF7;padding:32px;border-radius:28px;max-width:340px;text-align:center">
<h1 style="margin-top:0">Mon Orga</h1><p>Tape le code à 6 chiffres affiché sur le téléphone<br><small>Type the 6-digit code shown on the phone</small></p>
<input name="k" inputmode="numeric" maxlength="6" autofocus style="font-size:28px;width:7em;text-align:center;letter-spacing:.2em;padding:8px;border-radius:12px;border:2px solid #6750A4">
<p><button style="font-size:18px;padding:12px 28px;border:0;border-radius:99px;background:#6750A4;color:#fff">OK</button></p></form></body></html>"""
    }
}

// Keeps the server running while "Open Mon Orga on the PC" is on, with the address in a notification.
class SyncService : Service() {
    private var server: SyncServer? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { prefs().edit().putBoolean("syncOn", false).apply(); stopSelf(); return START_NOT_STICKY }
        val s = settings(prefs()); val t = Reminders.texts(this, s)
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, t.getString(R.string.ch_pc), NotificationManager.IMPORTANCE_LOW))
        val url = syncUrl(this)
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_pc).setColor(0xFF6750A4.toInt())
            .setContentTitle(t.getString(R.string.pc_active))
            .setContentText(if (url != null) t.getString(R.string.pc_text, url.substringBefore("/?"), syncCode(this)) else t.getString(if (s.sober) R.string.pc_no_wifi_sober else R.string.pc_no_wifi))
            .setVisibility(NotificationCompat.VISIBILITY_SECRET) // the code never shows on the lock screen
            .setContentIntent(Reminders.openApp(this, null))
            .addAction(0, t.getString(R.string.act_stop), PendingIntent.getService(this, 3, Intent(this, SyncService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE))
            .setOngoing(true).build()
        ServiceCompat.startForeground(this, 2, notification, if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0)
        if (server == null) server = runCatching { SyncServer(this).also { it.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false) } }.getOrNull()
        running = true
        return START_STICKY
    }

    // Android 15 limits this kind of service to 6 hours a day; opening the app starts it again.
    override fun onTimeout(startId: Int, fgsType: Int) = stopSelf()

    override fun onDestroy() {
        server?.stop(); server = null; running = false
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL = "pc"
        private const val STOP = "com.sayan.todo.STOP_PC"
        @Volatile var running = false
            private set

        fun start(ctx: Context) { runCatching { ctx.startForegroundService(Intent(ctx, SyncService::class.java)) } }
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, SyncService::class.java)); running = false }
    }
}
