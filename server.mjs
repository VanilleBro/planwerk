import express from 'express';
import { WebUntis } from 'webuntis';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

// ESM Support für absolute Pfade in Node.js
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Statische Dateien und JSON Middleware
app.use(express.static(__dirname));
app.use(express.json());

// Auf Vercel ist nur das /tmp-Verzeichnis schreibbar
const DATA_FILE = process.env.VERCEL 
    ? path.join('/tmp', 'timetable_cache.json') 
    : path.join(process.cwd(), 'timetable_cache.json');

// ==========================================
// DEINE ZUGANGSDATEN (Anno-Gymnasium Siegburg)
// ==========================================
const school = "anno-gym-siegburg";
const untisUsername = "EF";
const untisPassword = "580292Qa";
const untisServer = "anno-gym-siegburg.webuntis.com";
// ==========================================

function loadCachedData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            return JSON.parse(rawData);
        }
    } catch (err) {
        console.error("Fehler beim Laden des lokalen Speichers:", err.message);
    }
    return {};
}

function saveCachedData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error("Fehler beim Speichern der Daten:", err.message);
    }
}

const localDatabase = loadCachedData();
const DEFAULT_SETTINGS = { hiddenCourses: {}, eventsDisabled: false };
let notifiedKeys = new Set();

// Sendet eine echte Android-Benachrichtigung über Termux (nur lokal)
function triggerAndroidNotification(title, message) {
    if (process.env.VERCEL) return;
    const safeTitle = title.replace(/"/g, '\\"');
    const safeMsg = message.replace(/"/g, '\\"');
    exec(`termux-notification --title "${safeTitle}" --content "${safeMsg}" --priority high`, (err) => {
        // Ignorieren falls termux-api nicht installiert ist
    });
}

function parseElements(list) {
    if (!Array.isArray(list)) return [];
    return list.map(item => ({
        id: item.id || 0,
        name: item.name || item.element?.name || "",
        longname: item.longname || item.longName || item.element?.longName || item.name || ""
    }));
}

// Kerngeschäft: Stundenplan aus WebUntis abrufen
async function fetchTimetableFromUntis() {
    const userKey = untisUsername.toLowerCase();
    const untis = new WebUntis(school, untisUsername, untisPassword, untisServer);

    try {
        await untis.login();

        const today = new Date();
        const nextTwoWeeks = new Date();
        nextTwoWeeks.setDate(today.getDate() + 14);

        const timetable = await untis.getOwnTimetableForRange(today, nextTwoWeeks);

        const normalizedTimetable = timetable.map(lesson => ({
            id: lesson.id,
            date: lesson.date,
            startTime: lesson.startTime,
            endTime: lesson.endTime,
            sg: lesson.sg || lesson.studentGroup || "",
            substText: lesson.substText || "",
            activityType: lesson.activityType || lesson.lessonText || "Unterricht",
            code: lesson.code || "",
            kl: parseElements(lesson.kl || lesson.classes),
            te: parseElements(lesson.te || lesson.teachers),
            su: parseElements(lesson.su || lesson.subjects),
            ro: parseElements(lesson.ro || lesson.rooms)
        }));

        await untis.logout();

        if (!localDatabase[userKey]) {
            localDatabase[userKey] = { settings: DEFAULT_SETTINGS };
        }

        localDatabase[userKey].lastUpdated = new Date().toISOString();
        localDatabase[userKey].timetable = normalizedTimetable;
        saveCachedData(localDatabase);

        // Auf Entfälle im Hintergrund prüfen
        normalizedTimetable.forEach(lesson => {
            const isEntfall = (lesson.substText || '').toLowerCase().includes('entfall') || lesson.code === 'cancelled';
            if (isEntfall) {
                const entfallKey = `${lesson.id || lesson.startTime}_${lesson.date}`;
                if (!notifiedKeys.has(entfallKey)) {
                    notifiedKeys.add(entfallKey);
                    const subject = lesson.su?.[0]?.name || 'Unterricht';
                    triggerAndroidNotification("⚠️ Stundenentfall!", `${subject} am ${lesson.date} fällt aus!`);
                }
            }
        });

        return normalizedTimetable;

    } catch (error) {
        try { await untis.logout(); } catch(e) {}

        if (localDatabase[userKey] && localDatabase[userKey].timetable) {
            return localDatabase[userKey].timetable;
        }
        throw error;
    }
}

// Hauptseite ausliefern
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// API Routen
app.get("/api/auto-login", (req, res) => {
    const userKey = untisUsername.toLowerCase();
    const settings = localDatabase[userKey]?.settings || DEFAULT_SETTINGS;
    res.json({ token: "fixed_local_token", settings, username: untisUsername });
});

app.post("/api/login", (req, res) => {
    const userKey = untisUsername.toLowerCase();
    const settings = localDatabase[userKey]?.settings || DEFAULT_SETTINGS;
    res.json({ token: "fixed_local_token", settings, username: untisUsername });
});

app.post("/api/register", (req, res) => {
    const userKey = untisUsername.toLowerCase();
    const settings = localDatabase[userKey]?.settings || DEFAULT_SETTINGS;
    res.json({ token: "fixed_local_token", settings, username: untisUsername });
});

app.post("/api/logout", (req, res) => {
    res.json({ success: true });
});

app.get("/api/settings", (req, res) => {
    const userKey = untisUsername.toLowerCase();
    const settings = localDatabase[userKey]?.settings || DEFAULT_SETTINGS;
    res.json(settings);
});

app.post("/api/settings", (req, res) => {
    const userKey = untisUsername.toLowerCase();
    if (!localDatabase[userKey]) {
        localDatabase[userKey] = { timetable: [], settings: DEFAULT_SETTINGS };
    }

    const newSettings = req.body.settings || req.body;
    localDatabase[userKey].settings = newSettings;
    saveCachedData(localDatabase);

    res.json({ success: true, settings: newSettings });
});

app.get("/api/timetable", async (req, res) => {
    try {
        const data = await fetchTimetableFromUntis();
        res.json(data);
    } catch (error) {
        console.error("WebUntis Fehler:", error.message);
        res.status(500).json({ error: "Stundenplan konnte nicht geladen werden.", details: error.message });
    }
});

// Lokaler Serverstart & Polling (wird auf Vercel ignoriert)
if (!process.env.VERCEL) {
    setInterval(() => {
        fetchTimetableFromUntis().catch(err => {
            console.error("Hintergrund-Abruf Fehler:", err.message);
        });
    }, 30000);

    app.listen(PORT, () => {
        console.log(`Server läuft lokal auf Port ${PORT}`);
    });
}

// Export für Vercel Serverless Functions
export default app;

