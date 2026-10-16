package com.sayan.todo

import android.Manifest
import android.graphics.Color
import android.graphics.Paint
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.CalendarView
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.fragment.app.DialogFragment
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import com.google.android.material.color.MaterialColors
import com.google.android.material.datepicker.MaterialDatePicker
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.textfield.TextInputLayout
import com.google.android.material.timepicker.MaterialTimePicker
import com.google.android.material.timepicker.TimeFormat
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

class MainActivity : AppCompatActivity() {
    private val prefs by lazy { getSharedPreferences("todo", MODE_PRIVATE) }
    private val tasks = mutableListOf<Task>()
    private val notes = mutableListOf<String>()
    private val events = mutableListOf<Event>()
    private var today = LocalDate.now()
    private var day = today
    private var tab = 0
    private var noteDraft: Pair<Int, EditText>? = null // the open note editor, kept across recreation
    private val tabViews = listOf(R.id.tasksTab, R.id.notesTab, R.id.agendaTab)
    private val tabItems = listOf(R.id.tab_tasks, R.id.tab_notes, R.id.tab_agenda)
    private val nav by lazy { findViewById<BottomNavigationView>(R.id.nav) }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    private val dayFmt = DateTimeFormatter.ofPattern("EEEE d MMMM", Locale.FRENCH)
    private val shortFmt = DateTimeFormatter.ofPattern("EEE d MMM", Locale.FRENCH)
    private val monthFmt = DateTimeFormatter.ofPattern("MMMM", Locale.FRENCH)
    private val timeFmt = DateTimeFormatter.ofPattern("HH:mm")
    private val bravo = listOf("Bravo ! Une de moins 🎉", "Machine ! 💪", "Tu mérites une pause (courte) ☕", "Productivité : over 9000 🚀")

    override fun onCreate(savedInstanceState: Bundle?) {
        // The bottom tabs paint behind the navigation bar themselves, so no system scrim on top of them.
        enableEdgeToEdge(navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT))
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        // A picker restored after recreation has lost its callbacks, so it could not save anything.
        for (tag in listOf(TIME_PICKER, DATE_PICKER)) (supportFragmentManager.findFragmentByTag(tag) as? DialogFragment)?.dismissAllowingStateLoss()
        tasks += decodeTasks(prefs.getString("tasks", "")!!)
        notes += decodeNotes(prefs.getString("notes", "")!!)
        events += decodeEvents(prefs.getString("events", "")!!)
        savedInstanceState?.getString("day")?.let { day = LocalDate.parse(it) }

        // Edge-to-edge: pad for the status bar; while the keyboard is up, hide the tabs and sit above it.
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { root, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            root.setPadding(bars.left, bars.top, bars.right, ime)
            nav.visibility = if (ime > 0) View.GONE else View.VISIBLE
            insets
        }

        val input = findViewById<EditText>(R.id.taskInput)
        findViewById<View>(R.id.addTask).setOnClickListener { addTask(input) }
        // Blank Enter just closes the keyboard (this also swallows a hardware keyboard's second Enter event).
        input.setOnEditorActionListener { _, _, _ -> if (input.text.isBlank()) false else { addTask(input); true } }
        findViewById<View>(R.id.clearDone).setOnClickListener {
            val done = tasks.count { it.done }
            val s = if (done > 1) "s" else ""
            confirmDelete("Effacer les tâches terminées ?", "$done tâche$s cochée$s vont disparaître.") { tasks.removeAll { it.done } }
        }
        findViewById<View>(R.id.addNote).setOnClickListener { editNote(-1) }
        findViewById<View>(R.id.addEvent).setOnClickListener { editEvent(null) }
        selectDay(day)
        findViewById<CalendarView>(R.id.calendar).setOnDateChangeListener { _, y, m, d -> day = LocalDate.of(y, m + 1, d); renderAgenda() }

        nav.setOnItemSelectedListener { showTab(tabItems.indexOf(it.itemId)); true }
        nav.selectedItemId = tabItems[savedInstanceState?.getInt("tab") ?: 0]
        render()
        // e.g. the system switched to dark mode while a note was being typed
        savedInstanceState?.getString("note")?.let { editNote(savedInstanceState.getInt("notePos"), it) }
    }

    override fun onResume() {
        super.onResume()
        // Left open overnight: move the selection from yesterday to the new today.
        val now = LocalDate.now()
        if (now == today) return
        if (day == today) selectDay(now)
        today = now
        render()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putInt("tab", tab)
        if (day != today) outState.putString("day", day.toString())
        noteDraft?.let { (pos, input) ->
            outState.putInt("notePos", pos)
            outState.putString("note", input.text.toString())
        }
    }

    private fun showTab(i: Int) {
        tab = i
        tabViews.forEachIndexed { j, id -> findViewById<View>(id).visibility = if (j == i) View.VISIBLE else View.GONE }
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(window.decorView.windowToken, 0)
    }

    private fun render() {
        renderTasks()
        renderNotes()
        renderAgenda()
    }

    // shortcut: rebinds rows in place (keeps the tapped row's ripple); fine for a few hundred items, move to RecyclerView beyond that.
    private fun <T> fill(listId: Int, items: List<T>, layout: Int, bind: (View, T, Int) -> Unit) {
        val list = findViewById<LinearLayout>(listId)
        if (list.childCount > items.size) list.removeViews(items.size, list.childCount - items.size)
        items.forEachIndexed { i, item ->
            val row = list.getChildAt(i) ?: layoutInflater.inflate(layout, list, false).also { list.addView(it) }
            row.tag = item
            bind(row, item, i)
        }
    }

    private fun show(id: Int, visible: Boolean) {
        findViewById<View>(id).visibility = if (visible) View.VISIBLE else View.GONE
    }

    private fun renderTasks() {
        val hour = LocalTime.now().hour
        findViewById<TextView>(R.id.greeting).text =
            (if (hour in 5..17) "Bonjour ☀️ · " else "Bonsoir 🌙 · ") + dayFmt.format(today)
        fill(R.id.tasksList, tasks, R.layout.item_task) { row, task, i ->
            row.findViewById<ImageView>(R.id.check).setImageResource(if (task.done) R.drawable.ic_check_circle else R.drawable.ic_circle)
            row.findViewById<TextView>(R.id.text).apply {
                text = task.text
                paintFlags = if (task.done) paintFlags or Paint.STRIKE_THRU_TEXT_FLAG else paintFlags and Paint.STRIKE_THRU_TEXT_FLAG.inv()
                alpha = if (task.done) 0.7f else 1f
            }
            row.findViewById<TextView>(R.id.due).apply {
                val due = task.due
                visibility = if (due == null) View.GONE else View.VISIBLE
                if (due != null) {
                    text = "📅 " + dueLabel(due)
                    val late = !task.done && due.isBefore(LocalDateTime.now())
                    setTextColor(MaterialColors.getColor(this, if (late) androidx.appcompat.R.attr.colorError else androidx.appcompat.R.attr.colorPrimary))
                }
            }
            row.contentDescription = (if (task.done) "Fait : " else "À faire : ") + task.text
            row.setOnClickListener {
                tasks[i] = task.copy(done = !task.done)
                tasks.sortBy { it.done } // stable: open tasks first, each group keeps its order
                if (!task.done) toast(bravo.random())
                save()
            }
            row.setOnLongClickListener { editTask(i); true }
        }
        val done = tasks.count { it.done }
        val todo = tasks.size - done
        findViewById<TextView>(R.id.tasksSummary).text =
            if (todo == 0) "Tout est fait" else "$todo à faire" + if (done > 0) " · $done terminée${if (done > 1) "s" else ""}" else ""
        findViewById<LinearProgressIndicator>(R.id.tasksProgress).progress = if (tasks.isEmpty()) 0 else done * 100 / tasks.size
        for (id in listOf(R.id.tasksSummary, R.id.tasksProgress, R.id.tasksHint)) show(id, tasks.isNotEmpty())
        show(R.id.clearDone, done > 0)
    }

    private fun renderNotes() {
        fill(R.id.notesList, notes, R.layout.item_note) { row, note, i ->
            val lines = note.lines()
            row.findViewById<TextView>(R.id.title).text = lines.first()
            row.findViewById<TextView>(R.id.body).apply {
                text = lines.drop(1).joinToString("\n").trim()
                visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
            }
            row.setOnClickListener { editNote(i) }
            row.setOnLongClickListener { confirmDelete(lines.first()) { notes.removeAt(i) }; true }
        }
        findViewById<TextView>(R.id.notesSummary).text = "${notes.size} note${if (notes.size > 1) "s" else ""}"
        show(R.id.notesSummary, notes.isNotEmpty())
        show(R.id.notesHint, notes.isNotEmpty())
    }

    private fun renderAgenda() {
        val open = tasks.filter { !it.done && it.due != null }
        val month = (events.map { it.day } + open.map { it.due!!.toLocalDate() })
            .filter { it.year == day.year && it.month == day.month }.map { it.dayOfMonth }.distinct().sorted()
        show(R.id.monthSummary, month.isNotEmpty())
        if (month.isNotEmpty()) findViewById<TextView>(R.id.monthSummary).text =
            "📌 En ${monthFmt.format(day)} : " + frenchList(month.map { if (it == 1) "le 1er" else "le $it" })
        findViewById<TextView>(R.id.dayLabel).text = if (day == today) "Aujourd'hui" else dayFmt.format(day).replaceFirstChar { it.uppercase() }
        // The day's events and scheduled tasks together, all-day events first, then by time.
        val onDay: List<Any> = (eventsOn(events, day).map { (it.time ?: LocalTime.MIN) to it } +
            open.filter { it.due!!.toLocalDate() == day }.map { it.due!!.toLocalTime() to it })
            .sortedBy { it.first }.map { it.second }
        fill(R.id.eventsList, onDay, R.layout.item_event) { row, item, _ ->
            val time = row.findViewById<TextView>(R.id.time)
            val text = row.findViewById<TextView>(R.id.text)
            when (item) {
                is Event -> {
                    time.text = item.time?.let(timeFmt::format) ?: "Journée"
                    text.text = item.text
                    row.setOnClickListener { editEvent(item) }
                    row.setOnLongClickListener { confirmDelete(item.text) { events.remove(item) }; true }
                }
                is Task -> {
                    time.text = timeFmt.format(item.due!!)
                    text.text = "☐ " + item.text
                    row.setOnClickListener { editTask(tasks.indexOf(item)) }
                    row.setOnLongClickListener { confirmDelete(item.text) { tasks.remove(item) }; true }
                }
            }
        }
        show(R.id.eventsHint, onDay.isNotEmpty())
        val next = upcoming(events, LocalDateTime.now()).filter { it.day != day }.take(3)
        show(R.id.upcomingTitle, next.isNotEmpty())
        fill(R.id.upcomingList, next, R.layout.item_event) { row, event, _ ->
            row.findViewById<TextView>(R.id.time).text = shortFmt.format(event.day)
            row.findViewById<TextView>(R.id.text).text = (event.time?.let { timeFmt.format(it) + " · " } ?: "") + event.text
            row.setOnClickListener { editEvent(event) }
            row.setOnLongClickListener { confirmDelete(event.text) { events.remove(event) }; true }
        }
    }

    private fun frenchList(items: List<String>) =
        if (items.size == 1) items[0] else items.dropLast(1).joinToString(", ") + " et " + items.last()

    private fun dueLabel(due: LocalDateTime): String {
        val d = due.toLocalDate()
        val day = when (d) { today -> "Aujourd'hui"; today.plusDays(1) -> "Demain"; else -> shortFmt.format(d) }
        return "$day à " + timeFmt.format(due)
    }

    private fun selectDay(d: LocalDate) {
        day = d
        findViewById<CalendarView>(R.id.calendar).date = d.atTime(12, 0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
    }

    private fun addTask(input: EditText) {
        val text = clean(input.text.toString())
        if (text.isEmpty()) return toast("Une tâche vide ? Même moi je peux la faire 😏")
        tasks.add(0, Task(text))
        input.text?.clear()
        save()
    }

    private fun editTask(i: Int) {
        val task = tasks[i]
        var due = task.due
        val (view, input) = dialogInput("Tâche", "Ex. : ranger le linge 🧺")
        input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        input.setText(task.text)
        val dueButton = view.findViewById<MaterialButton>(R.id.dialogDue)
        fun showDue() { dueButton.text = due?.let { "📅 " + dueLabel(it) } ?: "📅 Programmer un rappel" }
        showDue()
        dueButton.visibility = View.VISIBLE
        dueButton.setOnClickListener {
            MaterialDatePicker.Builder.datePicker()
                .setTitleText("Pour quel jour ?")
                .setSelection((due?.toLocalDate() ?: today).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
                .setNegativeButtonText("Sans rappel")
                .build()
                .apply {
                    addOnNegativeButtonClickListener { due = null; showDue() }
                    addOnPositiveButtonClickListener { millis ->
                        val chosen = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()
                        MaterialTimePicker.Builder()
                            .setTimeFormat(TimeFormat.CLOCK_24H)
                            .setInputMode(MaterialTimePicker.INPUT_MODE_CLOCK)
                            .setHour(due?.hour ?: 9)
                            .setMinute(due?.minute ?: 0)
                            .setTitleText("À quelle heure ?")
                            .build()
                            .apply { addOnPositiveButtonClickListener { due = chosen.atTime(hour, minute); showDue() } }
                            .show(supportFragmentManager, TIME_PICKER)
                    }
                }
                .show(supportFragmentManager, DATE_PICKER)
        }
        MaterialAlertDialogBuilder(this)
            .setTitle("Modifier la tâche")
            .setView(view)
            .setPositiveButton("Enregistrer") { _, _ ->
                val text = clean(input.text.toString())
                if (text.isEmpty()) return@setPositiveButton toast("Une tâche vide ? Même moi je peux la faire 😏")
                tasks[i] = task.copy(text = text, due = due)
                save()
                if (due != null && Build.VERSION.SDK_INT >= 33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            .setNeutralButton("Supprimer") { _, _ -> confirmDelete(task.text) { tasks.removeAt(i) } }
            .setNegativeButton("Annuler", null)
            .show()
    }

    // pos = -1 for a new note.
    private fun editNote(pos: Int, text: String? = notes.getOrNull(pos)) {
        val (view, input) = dialogInput("Ta note", "Ex. : liste de courses, code du Wi-Fi…")
        input.apply {
            setText(text)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            minLines = 4
            maxLines = 10
            gravity = Gravity.TOP
        }
        fun commit(): Boolean {
            val note = input.text.toString().trim()
            if (note.isEmpty()) return false
            if (pos < 0) notes.add(0, note) else notes[pos] = note
            save()
            return true
        }
        noteDraft = pos to input
        MaterialAlertDialogBuilder(this)
            .setTitle(if (pos < 0) "Nouvelle note" else "Modifier la note")
            .setView(view)
            .setPositiveButton("Enregistrer") { _, _ -> if (!commit()) toast("Une note vide… très zen 🧘") }
            .setNegativeButton("Annuler", null)
            .apply { if (pos >= 0) setNeutralButton("Supprimer") { _, _ -> confirmDelete(notes[pos].lines().first()) { notes.removeAt(pos) } } }
            .setOnCancelListener { commit() } // Back saves, like most note apps; only "Annuler" throws the text away
            .setOnDismissListener { noteDraft = null }
            .show()
            .setCanceledOnTouchOutside(false)
    }

    // old = null for a new event; prefill brings the typed name back when the time picker is backed out of.
    private fun editEvent(old: Event?, prefill: String = old?.text ?: "") {
        val onDay = old?.day ?: day
        val (view, input) = dialogInput("C'est quoi ?", "Ex. : dentiste, foot, anniv de mamie…")
        input.setText(prefill)
        input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        val text = { clean(input.text.toString()) }
        fun put(time: LocalTime?) {
            old?.let { events.remove(it) }
            events += Event(onDay, time, text())
            save()
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(if (old == null) "Nouvel événement" else "Modifier l'événement")
            .setMessage("Le " + dayFmt.format(onDay))
            .setView(view)
            .setPositiveButton("Choisir l'heure") { _, _ ->
                if (text().isEmpty()) return@setPositiveButton toast("Un événement sans nom ? Très mystérieux… 🕵️")
                MaterialTimePicker.Builder()
                    .setTimeFormat(TimeFormat.CLOCK_24H)
                    .setInputMode(MaterialTimePicker.INPUT_MODE_CLOCK)
                    .setHour(old?.time?.hour ?: LocalTime.now().hour)
                    .setMinute(old?.time?.minute ?: 0)
                    .setTitleText("${text()} : à quelle heure ?")
                    .setNegativeButtonText("Journée") // short so it never covers the keyboard toggle at large font sizes
                    .build()
                    .apply {
                        addOnPositiveButtonClickListener { put(LocalTime.of(hour, minute)) }
                        addOnNegativeButtonClickListener { put(null) }
                        addOnCancelListener { editEvent(old, text()) }
                    }
                    .show(supportFragmentManager, TIME_PICKER)
            }
            .setNegativeButton("Annuler", null)
            .apply { if (old != null) setNeutralButton("Supprimer") { _, _ -> confirmDelete(old.text) { events.remove(old) } } }
            .show()
    }

    private fun dialogInput(label: String, example: String): Pair<View, EditText> {
        val view = layoutInflater.inflate(R.layout.dialog_input, null)
        view.findViewById<TextInputLayout>(R.id.dialogInputLayout).apply { hint = label; placeholderText = example }
        return view to view.findViewById(R.id.dialogInput)
    }

    private fun confirmDelete(label: String, delete: () -> Unit) =
        confirmDelete("Supprimer ?", "« $label » va disparaître pour toujours.", delete)

    private fun confirmDelete(title: String, message: String, delete: () -> Unit) {
        MaterialAlertDialogBuilder(this)
            .setTitle(title)
            .setMessage(message)
            .setPositiveButton("Oui, adieu 👋") { _, _ -> delete(); save() }
            .setNegativeButton("Non", null)
            .show()
    }

    private fun save() {
        render()
        prefs.edit()
            .putString("tasks", encodeTasks(tasks))
            .putString("notes", encodeNotes(notes))
            .putString("events", encodeEvents(events))
            .apply()
        Reminders.schedule(this, tasks)
    }

    private fun toast(msg: String) {
        Snackbar.make(findViewById(R.id.tabs), msg, Snackbar.LENGTH_SHORT).apply {
            // Sit above the FAB on the notes tab, above the tabs elsewhere (they are hidden while typing).
            if (tab == 1) setAnchorView(R.id.addNote) else if (nav.visibility == View.VISIBLE) anchorView = nav
        }.show()
    }

    private companion object {
        const val TIME_PICKER = "time"
        const val DATE_PICKER = "date"
    }
}
