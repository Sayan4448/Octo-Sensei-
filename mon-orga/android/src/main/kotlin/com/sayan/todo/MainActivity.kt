package com.sayan.todo

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import android.speech.RecognizerIntent
import android.util.Base64
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.time.LocalDate
import kotlin.concurrent.thread
import kotlin.math.roundToInt

// The app is the shared interface (web/src, bundled as assets) in a WebView. This activity gives it what a web page
// cannot do alone: storage shared with the reminders, files, voice, sharing, the lock, the PC server.
class MainActivity : AppCompatActivity() {
    companion object {
        const val OPEN = "com.sayan.todo.OPEN"
        const val ADD_TASK = "com.sayan.todo.ADD_TASK"
        const val ADD_NOTE = "com.sayan.todo.ADD_NOTE"
        const val ADD_EVENT = "com.sayan.todo.ADD_EVENT"
        const val VOICE = "com.sayan.todo.VOICE"
        const val VOICE_NOTE = "com.sayan.todo.VOICE_NOTE"
        const val HOST = "appassets.androidplatform.net" // reserved by Android for local content, never fetched from the network
        const val START = "https://$HOST/index.html"
        private const val LOCK_AFTER = 30_000L
        private val AUTH = BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        private const val ADD_TASK_ACTION = """{"type":"add-task"}"""
        private val ICS = setOf("text/calendar", "text/x-vcalendar", "application/ics")
    }

    lateinit var web: WebView
    private lateinit var frame: FrameLayout
    private var lockView: View? = null
    private var pendingAction: String? = null
    private var pageReady = false
    private var pausedAt = 0L
    private var exportId = ""; private var exportText = ""; private var importId = ""; private var voiceId = ""; private var permissionId = ""; private var folderId = ""
    private var calendarAsk: Triple<String, String, String>? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var photoUri: Uri? = null

    private val exportJson = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { onExported(it) }
    private val exportIcs = registerForActivityResult(ActivityResultContracts.CreateDocument("text/calendar")) { onExported(it) }
    private val exportTxt = registerForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { onExported(it) }
    private val importer = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val text = uri?.let { u -> runCatching { contentResolver.openInputStream(u)!!.use { it.readBytes() }.takeIf { it.size < 40_000_000 }?.toString(Charsets.UTF_8) }.getOrNull() }
        answer(importId, if (text == null) "null" else JSONObject.quote(JSONObject().put("name", uri.lastPathSegment.orEmpty()).put("text", text).toString()))
    }
    private val voiceLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val text = r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        answer(voiceId, text?.let { JSONObject.quote(it) } ?: "null")
    }
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { answer(permissionId, it.toString()) }
    private val photo = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        fileCallback?.onReceiveValue(uri?.let { arrayOf(it) }); fileCallback = null
    }
    private val camera = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        fileCallback?.onReceiveValue(photoUri?.takeIf { ok }?.let { arrayOf(it) }); fileCallback = null
    }
    private val calendarPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        val (id, from, to) = calendarAsk ?: return@registerForActivityResult
        calendarAsk = null
        if (ok) answerEvents(id, from, to) else answer(id, "null")
    }
    private val folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        val name = uri?.let { runCatching { Backup.setFolder(this, it) }.getOrNull() }
        answer(folderId, name?.let { JSONObject().put("name", it).toString() } ?: "null")
    }
    // Reminders, the PC or a notification button changed the data: the page reloads it.
    private val prefsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == STATE_KEY && pageReady) web.evaluateJavascript("window.__hostChanged && __hostChanged()", null)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        frame = FrameLayout(this)
        web = WebView(this)
        frame.addView(web, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        setContentView(frame)
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        paint(resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES) // until the page says its theme
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            textZoom = (resources.configuration.fontScale * 100).roundToInt() // follow the phone's text size
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (request.url.host == HOST) asset(request.url.path.orEmpty().trimStart('/')) else null

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                open(request.url); return true
            }

            override fun onPageFinished(view: WebView, url: String) { pageReady = true }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null); fileCallback = callback
                try {
                    // capture="environment": the camera, into a file the page then reads; otherwise the gallery.
                    if (params.isCaptureEnabled) camera.launch(FileProvider.getUriForFile(this@MainActivity, "$packageName.files",
                        File(cacheDir, "camera").apply { mkdirs() }.resolve("photo.jpg")).also { photoUri = it })
                    else photo.launch("image/*")
                } catch (e: ActivityNotFoundException) { callback.onReceiveValue(null); fileCallback = null }
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "Android")
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!pageReady) return moveTaskToBack(true).let { }
                web.evaluateJavascript("(window.app && window.app.back()) ? 'yes' : 'no'") { r -> if (r?.contains("yes") != true) moveTaskToBack(true) }
            }
        })
        pendingAction = actionOf(intent)
        prefs().registerOnSharedPreferenceChangeListener(prefsListener)
        secure()
        if (mustUnlock()) lock() else web.loadUrl(START)
        Reminders.channels(this)
        Reminders.schedule(this) // not edited(): reminders missed while the phone was off must still ring
        Widget.update(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val action = actionOf(intent) ?: return
        if (pageReady) web.evaluateJavascript("window.app && app.action($action)") { if (action == ADD_TASK_ACTION) keyboard() } else pendingAction = action
    }

    override fun onStop() {
        super.onStop()
        Backup.later(this)
    }

    override fun onPause() {
        super.onPause()
        pausedAt = System.currentTimeMillis()
        if (pageReady) web.evaluateJavascript("window.app && app.flush()", null)
    }

    override fun onResume() {
        super.onResume()
        secure()
        if (pausedAt > 0 && System.currentTimeMillis() - pausedAt > LOCK_AFTER && mustUnlock()) lock()
        if (pageReady) web.evaluateJavascript("window.app && app.refresh()", null)
        if (prefs().getBoolean("syncOn", false) && !SyncService.running) SyncService.start(this)
    }

    override fun onDestroy() {
        prefs().unregisterOnSharedPreferenceChangeListener(prefsListener)
        super.onDestroy()
    }

    private fun actionOf(i: Intent?): String? = when (i?.action) {
        // A tap on a reminder answers it (no more re-rings) and opens it.
        OPEN -> i.getStringExtra(Reminders.EXTRA_ID)?.let { Reminders.answered(this, it); JSONObject().put("type", "open").put("id", it).toString() }
        ADD_TASK -> ADD_TASK_ACTION
        ADD_NOTE -> """{"type":"add-note"}"""
        ADD_EVENT -> """{"type":"add-event"}"""
        VOICE -> """{"type":"voice"}"""
        VOICE_NOTE -> """{"type":"voice-note"}"""
        Intent.ACTION_VIEW -> read(i.data, 2_000_000)?.let { ics(String(it)) } // an .ics file opened from another app
        Intent.ACTION_SEND -> {
            val stream = IntentCompat.getParcelableExtra(i, Intent.EXTRA_STREAM, Uri::class.java)
            val text = i.getStringExtra(Intent.EXTRA_TEXT)
            when {
                i.type?.startsWith("image/") == true -> read(stream, 10_000_000)?.let { bytes -> // a photo becomes a note
                    val mime = (stream?.let { contentResolver.getType(it) } ?: i.type)?.takeIf { !it.endsWith("*") } ?: "image/jpeg"
                    JSONObject().put("type", "image").put("src", "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)).put("text", text.orEmpty()).toString()
                }
                i.type in ICS -> (read(stream, 2_000_000)?.let { String(it) } ?: text)?.let { ics(it) }
                else -> text?.let {
                    val subject = i.getStringExtra(Intent.EXTRA_SUBJECT)
                    JSONObject().put("type", "share").put("text", if (subject != null && !it.contains(subject)) "$subject\n$it" else it).toString()
                }
            }
        }
        else -> null
    }

    private fun ics(text: String) = JSONObject().put("type", "ics").put("text", text).toString()

    // A shared file's bytes (content:// only), or null when it cannot be read or is bigger than `cap`.
    private fun read(uri: Uri?, cap: Int): ByteArray? = runCatching {
        if (uri?.scheme != "content") return null
        contentResolver.openInputStream(uri)!!.use { s ->
            val out = ByteArrayOutputStream(); val buf = ByteArray(65_536)
            while (out.size() <= cap) { val n = s.read(buf); if (n < 0) return out.toByteArray(); out.write(buf, 0, n) }
            null
        }
    }.getOrNull()

    // The page focuses the new task's field; Android shows the keyboard only when asked natively.
    private fun keyboard() = web.postDelayed({ web.requestFocus(); getSystemService(InputMethodManager::class.java).showSoftInput(web, 0) }, 300)

    // The window behind the page and the bar icons follow the theme the interface shows (it may differ from the phone's).
    private fun paint(dark: Boolean) {
        val bg = if (dark) 0xFF141218.toInt() else 0xFFFEF7FF.toInt() // the interface's --surface
        window.decorView.setBackgroundColor(bg); frame.setBackgroundColor(bg); web.setBackgroundColor(bg)
        WindowCompat.getInsetsController(window, frame).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark }
    }

    private fun answerEvents(id: String, from: String, to: String) = thread {
        answer(id, runCatching { deviceEvents(contentResolver, LocalDate.parse(from), LocalDate.parse(to)).toString() }.getOrDefault("null"))
    }

    // Android 12+ wallpaper colours, for the interface's theme.
    @RequiresApi(31)
    private fun dynamicColors() = JSONObject().apply {
        for ((k, c) in listOf("primary" to android.R.color.system_accent1_600, "primaryDark" to android.R.color.system_accent1_200,
            "container" to android.R.color.system_accent1_100, "containerDark" to android.R.color.system_accent1_700,
            "onContainer" to android.R.color.system_accent1_900, "onContainerDark" to android.R.color.system_accent1_100)) put(k, hex(getColor(c)))
    }

    private fun asset(path: String): WebResourceResponse {
        val name = path.ifEmpty { "index.html" }
        val mime = when (name.substringAfterLast('.')) {
            "html" -> "text/html"; "js" -> "text/javascript"; "css" -> "text/css"; "svg" -> "image/svg+xml"; "json" -> "application/json"; else -> "application/octet-stream"
        }
        return try { WebResourceResponse(mime, "utf-8", assets.open(name)) }
        catch (e: IOException) { WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), ByteArrayInputStream(ByteArray(0))) }
    }

    // Links, phone numbers, e-mails and addresses open in the matching app; nothing else leaves the app.
    private fun open(uri: Uri) {
        val intent = when (uri.scheme) {
            "http", "https", "mailto", "geo" -> Intent(Intent.ACTION_VIEW, uri)
            "tel" -> Intent(Intent.ACTION_DIAL, uri)
            else -> return
        }
        start(intent)
    }

    private fun start(intent: Intent) {
        try { startActivity(intent) } catch (e: ActivityNotFoundException) { Toast.makeText(this, Reminders.texts(this).getString(R.string.no_app), Toast.LENGTH_SHORT).show() }
    }

    private fun answer(id: String, json: String) = runOnUiThread {
        web.evaluateJavascript("window.__hostResult && __hostResult(${JSONObject.quote(id)}, $json)", null)
    }

    private fun onExported(uri: Uri?) {
        val ok = uri != null && runCatching { contentResolver.openOutputStream(uri, "wt")!!.use { it.write(exportText.toByteArray()) } }.isSuccess
        exportText = ""
        answer(exportId, ok.toString())
    }

    // ---------- lock ----------

    private fun mustUnlock() = settings(prefs()).lock && BiometricManager.from(this).canAuthenticate(AUTH) == BiometricManager.BIOMETRIC_SUCCESS

    private fun secure() {
        if (settings(prefs()).lock) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    private fun lock() {
        web.visibility = View.INVISIBLE
        val view = lockView ?: layoutInflater.inflate(R.layout.lock, frame, false).also { v ->
            frame.addView(v); lockView = v
            v.findViewById<Button>(R.id.unlock).apply { text = Reminders.texts(this@MainActivity).getString(R.string.lock_button); setOnClickListener { prompt() } }
        }
        view.visibility = View.VISIBLE
        prompt()
    }

    private fun prompt() {
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                lockView?.visibility = View.GONE
                web.visibility = View.VISIBLE
                if (web.url == null) web.loadUrl(START)
            }
        }).authenticate(BiometricPrompt.PromptInfo.Builder().setTitle(Reminders.texts(this).getString(R.string.lock_title)).setAllowedAuthenticators(AUTH).build())
    }

    // ---------- reminder checks ----------

    private fun checks(): List<Pair<String, Boolean>> {
        val out = mutableListOf("notifications" to NotificationManagerCompat.from(this).areNotificationsEnabled())
        if (Build.VERSION.SDK_INT >= 31) out += "exact" to getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
        out += "battery" to getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        if (Build.VERSION.SDK_INT >= 34) out += "fullscreen" to getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
        out += "storage" to (filesDir.usableSpace > 50L * 1024 * 1024)
        // Battery savers no app can read: never green, the user checks them once.
        when (Build.MANUFACTURER.lowercase()) { "samsung" -> out += "samsung" to false; "xiaomi" -> out += "xiaomi" to false }
        return out
    }

    @SuppressLint("BatteryLife") // a reminder app is an accepted reason, and the user decides
    private fun fixSetting(key: String) {
        val pkg = Uri.parse("package:$packageName")
        val intents = when (key) {
            "notifications" -> listOf(Intent(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(AndroidSettings.EXTRA_APP_PACKAGE, packageName))
            "exact" -> if (Build.VERSION.SDK_INT >= 31) listOf(Intent(AndroidSettings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg)) else emptyList()
            "battery" -> listOf(Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg), Intent(AndroidSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            "fullscreen" -> if (Build.VERSION.SDK_INT >= 34) listOf(Intent(AndroidSettings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg)) else emptyList()
            "storage" -> listOf(Intent(AndroidSettings.ACTION_INTERNAL_STORAGE_SETTINGS))
            "xiaomi" -> listOf(Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")))
            else -> emptyList() // samsung: the app's page, then Battery > Unrestricted
        } + Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
        for (i in intents) try { startActivity(i); return } catch (e: ActivityNotFoundException) { /* next */ } catch (e: SecurityException) { /* next */ }
    }

    // ---------- what the page can call (window.Android), on a background thread ----------

    private inner class Bridge {
        @JavascriptInterface fun info(): String = JSONObject()
            .put("version", runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "")
            .put("sdk", Build.VERSION.SDK_INT)
            .put("voice", Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).resolveActivity(packageManager) != null)
            .put("a11yTimeout", if (Build.VERSION.SDK_INT >= 29) getSystemService(AccessibilityManager::class.java)
                .getRecommendedTimeoutMillis(10_000, AccessibilityManager.FLAG_CONTENT_TEXT or AccessibilityManager.FLAG_CONTENT_CONTROLS) else 10_000)
            .put("calendar", true).put("camera", true).put("shareImage", true)
            .apply { if (Build.VERSION.SDK_INT >= 31) put("dynamic", dynamicColors()) }
            .toString()

        @JavascriptInterface fun theme(dark: Boolean) = runOnUiThread { paint(dark) }

        @JavascriptInterface fun load(): String = loadDoc(prefs()).toString()

        @JavascriptInterface fun save(json: String): String {
            val incoming = runCatching { JSONObject(json) }.getOrNull() ?: return loadDoc(prefs()).toString()
            val merged = syncDoc(prefs(), incoming) ?: return """{"error":"storage"}""" // the interface says the phone is full
            Reminders.edited(this@MainActivity); Widget.update(this@MainActivity)
            return merged.toString()
        }

        @JavascriptInterface fun settings(): String = prefs().getString(SETTINGS_KEY, null) ?: "{}"

        @JavascriptInterface fun saveSettings(json: String) {
            if (runCatching { JSONObject(json) }.isFailure) return
            prefs().edit().putString(SETTINGS_KEY, json).apply()
            runOnUiThread { secure() }
            Reminders.channels(this@MainActivity); Reminders.schedule(this@MainActivity); Widget.update(this@MainActivity)
        }

        @JavascriptInterface fun share(title: String, text: String) = runOnUiThread {
            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text).putExtra(Intent.EXTRA_SUBJECT, title), null))
        }

        // A picture made by the page ("data:image/png;base64,…" or jpeg, 8 MB at most), shared as a file. False when unreadable.
        @JavascriptInterface fun shareImage(dataUrl: String, title: String): Boolean {
            val b64 = Regex("""^data:image/(png|jpeg);base64,""").find(dataUrl)?.let { dataUrl.substring(it.range.last + 1) } ?: return false
            val bytes = runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull()?.takeIf { it.isNotEmpty() && it.size <= 8 shl 20 } ?: return false
            val file = File(cacheDir, "share").apply { mkdirs() }.resolve("progress.png")
            if (runCatching { file.writeBytes(bytes) }.isFailure) return false
            val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", file)
            val send = Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_SUBJECT, title)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply { clipData = ClipData.newRawUri(title, uri) } // the chooser can show it too
            runOnUiThread { start(Intent.createChooser(send, title)) }
            return true
        }

        @JavascriptInterface fun copy(text: String): Boolean {
            runOnUiThread { getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Mon Orga", text)) }
            return true
        }

        @JavascriptInterface fun exportFile(id: String, name: String, mime: String, text: String) = runOnUiThread {
            exportId = id; exportText = text
            val launcher = when { mime.contains("calendar") -> exportIcs; mime.contains("json") -> exportJson; else -> exportTxt }
            try { launcher.launch(name) } catch (e: ActivityNotFoundException) { answer(id, "false") }
        }

        @JavascriptInterface fun importFile(id: String, accept: String) = runOnUiThread {
            importId = id
            try { importer.launch(arrayOf("*/*")) } catch (e: ActivityNotFoundException) { answer(id, "null") }
        }

        @JavascriptInterface fun voice(id: String) = runOnUiThread {
            voiceId = id
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, Reminders.texts(this@MainActivity).getString(R.string.voice_prompt))
            try { voiceLauncher.launch(intent) } catch (e: ActivityNotFoundException) { answer(id, "null") }
        }

        @JavascriptInterface fun openUrl(url: String) = runOnUiThread { open(Uri.parse(url)) }

        @JavascriptInterface fun notifyPermission(id: String) = runOnUiThread {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                permissionId = id; permission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else answer(id, "true")
        }

        @JavascriptInterface fun diagnostics(): String = JSONArray(checks().map { (k, ok) -> JSONObject().put("key", k).put("ok", ok) }).toString()

        @JavascriptInterface fun fix(key: String) = runOnUiThread { fixSetting(key) }

        @JavascriptInterface fun testAlarm(loud: Boolean) = Reminders.test(this@MainActivity, loud)

        @JavascriptInterface fun testAlarmIn(minutes: Int, loud: Boolean) = Reminders.test(this@MainActivity, loud, minutes.coerceIn(1, 24 * 60))

        @JavascriptInterface fun haptic() = runOnUiThread {
            web.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
        }

        @JavascriptInterface fun syncInfo(): String = syncInfo(this@MainActivity)

        @JavascriptInterface fun syncNewCode(): String {
            newSyncCode(this@MainActivity)
            if (SyncService.running) runOnUiThread { SyncService.start(this@MainActivity) } // its notification shows the code
            return syncInfo(this@MainActivity)
        }

        @JavascriptInterface fun syncSet(on: Boolean): String {
            prefs().edit().putBoolean("syncOn", on).commit()
            runOnUiThread { if (on) SyncService.start(this@MainActivity) else SyncService.stop(this@MainActivity) }
            return syncInfo(this@MainActivity)
        }

        @JavascriptInterface fun takeAction(): String? = pendingAction.also { pendingAction = null; if (it == ADD_TASK_ACTION) runOnUiThread { keyboard() } }

        // The phone's calendars, answered as an array (or null without the permission).
        @JavascriptInterface fun deviceEvents(id: String, fromDay: String, toDay: String) {
            if (checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED) answerEvents(id, fromDay, toDay)
            else runOnUiThread { calendarAsk = Triple(id, fromDay, toDay); calendarPermission.launch(Manifest.permission.READ_CALENDAR) }
        }

        @JavascriptInterface fun addToCalendar(json: String) = runOnUiThread { runCatching { calendarInsert(JSONObject(json)) }.getOrNull()?.let { start(it) } }

        @JavascriptInterface fun chooseBackupFolder(id: String) = runOnUiThread {
            folderId = id
            try { folderPicker.launch(null) } catch (e: ActivityNotFoundException) { answer(id, "null") }
        }

        @JavascriptInterface fun clearBackupFolder() = Backup.clear(this@MainActivity)

        @JavascriptInterface fun backupInfo(): String = Backup.info(this@MainActivity)

        // The assistant: the page names the service and the message; the key is kept here and only added to the request.
        @JavascriptInterface fun aiKey(key: String) = prefs().edit().apply { if (key.isBlank()) remove(AI_KEY) else putString(AI_KEY, key.trim()) }.apply()

        @JavascriptInterface fun ai(id: String, url: String, body: String) {
            thread { answer(id, Ai.call(url, prefs().getString(AI_KEY, null), body.ifEmpty { null })) }
        }
    }
}
