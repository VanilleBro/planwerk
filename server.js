app.	get("/api/timetable", requireAuth, async (req, res) => {
    const untis = new WebUntis(
        school,
        untisUsername,
        untisPassword,
        untisServer
    );

    try {
        await untis.login();

        // Holt die Daten für die nächsten 14 Tage
        const today = new Date();
        const nextTwoWeeks = new Date();
        nextTwoWeeks.setDate(today.getDate() + 14);

        const timetable = await untis.getOwnTimetableForRange(today, nextTwoWeeks);

        const normalizedTimetable = timetable.map(lesson => ({
            id: lesson.id,
            date: lesson.date,
            startTime: lesson.startTime,
            endTime: lesson.endTime,
            sg: lesson.studentGroup || "",
            substText: lesson.substText || "",
            activityType: lesson.lessonText || "Unterricht",
            kl: (lesson.classes || []).map(item => ({
                id: item.id,
                name: item.element?.name || "",
                longname: item.element?.longName || item.element?.name || ""
            })),
            te: (lesson.teachers || []).map(item => ({
                id: item.id,
                name: item.element?.name || "",
                longname: item.element?.longName || item.element?.name || ""
            })),
            su: (lesson.subjects || []).map(item => ({
                id: item.id,
                name: item.element?.name || "",
                longname: item.element?.longName || item.element?.name || ""
            })),
            ro: (lesson.rooms || []).map(item => ({
                id: item.id,
                name: item.element?.name || "",
                longname: item.element?.longName || item.element?.name || ""
            }))
        }));

        await untis.logout();
        res.json(normalizedTimetable);
    } catch (error) {
        console.error("WebUntis Detaillierter Fehler:", error);
        
        // Versuch eines sauberen Logouts bei Fehler
        try { await untis.logout(); } catch(e) {}

        res.status(500).json({
            error: "Stundenplan konnte nicht geladen werden.",
            details: error.message
        });
    }
});

