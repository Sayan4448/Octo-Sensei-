package com.sayan.todo

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

class StoreTest {
    private val monday = LocalDate.of(2026, 10, 19)

    @Test
    fun tasksRoundTrip() {
        val tasks = listOf(Task("Ranger le linge"), Task("1 truc qui commence par un chiffre", done = true))
        assertEquals(tasks, decodeTasks(encodeTasks(tasks)))
    }

    @Test
    fun scheduledTaskKeepsItsDue() {
        val tasks = listOf(Task("Poubelles", due = monday.atTime(18, 30)), Task("Sans date"))
        assertEquals(tasks, decodeTasks(encodeTasks(tasks)))
    }

    @Test
    fun nextDueIsTheEarliestOpenTaskStillAhead() {
        val now = monday.atTime(9, 0)
        val past = Task("Passé", due = now.minusHours(1))
        val done = Task("Fait", done = true, due = now.plusHours(1))
        val soon = Task("Bientôt", due = now.plusHours(2))
        val later = Task("Plus tard", due = now.plusDays(1))
        assertEquals(soon.due, nextDue(listOf(later, past, done, soon, Task("Sans date")), now))
        assertEquals(null, nextDue(listOf(past, done), now))
    }

    @Test
    fun readsV1Tasks() = assertEquals(listOf(Task("Courses"), Task("Sport", done = true)), decodeTasks("0Courses\n1Sport"))

    @Test
    fun notesKeepLineBreaksAndBackslashes() {
        val notes = listOf("Courses :\n- lait\n- pain", """C:\dossier\n pas un saut de ligne""", "a", "fin\\")
        assertEquals(notes, decodeNotes(encodeNotes(notes)))
    }

    @Test
    fun eventsRoundTrip() {
        val events = listOf(Event(monday, LocalTime.of(14, 30), "Dentiste | 2e étage"), Event(monday, null, "Anniv de mamie"))
        assertEquals(events, decodeEvents(encodeEvents(events)))
    }

    @Test
    fun emptyStorage() {
        assertEquals(emptyList<Task>(), decodeTasks(""))
        assertEquals(emptyList<String>(), decodeNotes(""))
        assertEquals(emptyList<Event>(), decodeEvents(""))
    }

    @Test
    fun dayIsSortedAllDayFirstThenByTime() {
        val foot = Event(monday, LocalTime.of(18, 0), "Foot")
        val dentist = Event(monday, LocalTime.of(9, 0), "Dentiste")
        val birthday = Event(monday, null, "Anniv")
        val otherDay = Event(monday.plusDays(1), null, "Autre jour")
        assertEquals(listOf(birthday, dentist, foot), eventsOn(listOf(foot, otherDay, dentist, birthday), monday))
    }

    @Test
    fun upcomingSkipsWhatIsOver() {
        val yesterday = Event(monday.minusDays(1), null, "Hier")
        val thisMorning = Event(monday, LocalTime.of(8, 0), "Ce matin")
        val allDayToday = Event(monday, null, "Toute la journée")
        val tonight = Event(monday, LocalTime.of(20, 0), "Ce soir")
        val later = Event(monday.plusDays(3), null, "Plus tard")
        val all = listOf(later, tonight, yesterday, thisMorning, allDayToday)
        assertEquals(listOf(allDayToday, thisMorning, tonight, later), upcoming(all, monday.atTime(7, 0)))
        assertEquals(listOf(allDayToday, tonight, later), upcoming(all, monday.atTime(9, 0)))
        assertEquals(emptyList<Event>(), upcoming(listOf(yesterday), monday.atStartOfDay()))
    }

    @Test
    fun cleanRemovesLineBreaks() = assertEquals("a b c", clean("  a\nb \r\n c  "))
}
