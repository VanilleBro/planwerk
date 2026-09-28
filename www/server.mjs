import express from 'express';
import { WebUntis } from 'webuntis';
import path from 'path';
import { fileURLToPath } from 'url';
import webpush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.use(express.json());

// -------------------------------------------------------------
// VAPID Keys für Android/Web-Push (Einmalig generiert oder fest)
// -------------------------------------------------------------
const vapidKeys = webpush.generateVAPIDKeys();
const publicVapidKey = process.env.VAPID_PUBLIC_KEY || vapidKeys.publicKey;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY || vapidKeys.privateKey;

webpush.setVapidDetails(
    'mailto:admin@planwerk.app',
    publicVapidKey,
    privateVapidKey
);

// Speicher für Push-Subscriptions & bereits gemeldete Änderungen
let pushSubscriptions = [];
let knownLessonKeys = new Set();
let isFirstPoll = true; // Verhindert Spam beim Server-Start

const UNTIS_CONFIG = {
    school: process.env.UNTIS_SCHOOL || "anno-gym-siegburg",
    username: process.env.UNTIS_USER || "EF",
    password: process.env.UNTIS_PASSWORD || "580292Qa",
    server: process.env.UNTIS_SERVER || "anno-gym-siegburg.webuntis.com"
};

function parseElements(list) {
    if (!Array.isArray(list)) return [];
    return list.map(item => ({
        id: item.id || 0,
        name: item.name || item.element?.name || "",
        longname: item.longname || item.longName || item.element?.longName || item.name || ""
    }));
}

function formatDate(v) {
    const t = String(v || '');
    return t.length === 8 ? `${t.slice(6)}.${t.slice(4, 6)}.${t.slice(0, 4)}` : '';
}

function formatTime(v) {
    const t = String(v || '').padStart(4, '0');
    return t.slice(0, 2) + ':' + t.slice(2);
}

async function fetchTimetableFromUntis() {
    const untis = new WebUntis(
        UNTIS_CONFIG.school,
        UNTIS_CONFIG.username,
        UNTIS_CONFIG.password,
        UNTIS_CONFIG.server
    );

    try {
        await untis.login();
        const today = new Date();
        const nextDays = new Date();
        nextDays.setDate(today.getDate() + 7);

        const timetable = await untis.getOwnTimetableForRange(today, nextDays);
        await untis.logout();

        return timetable.map(lesson => ({
            id: lesson.id,
            date: lesson.date,
            startTime: lesson.startTime,
            endTime: lesson.endTime,
            sg: lesson.sg || lesson.studentGroup || "",
            substText: lesson.substText || "",
            activityType: lesson.activityType || lesson.lessonText || "Unterricht",
            code: lesson.code || "",
            te: parseElements(lesson.te || lesson.teachers),
            su: parseElements(lesson.su || lesson.subjects),
            ro: parseElements(lesson.ro || lesson.rooms)
        }));
    } catch (error) {
        try { await untis.logout(); } catch (e) {}
        throw error;
    }
}

// -------------------------------------------------------------
// Hilfsfunktion: Push-Nachricht an alle Abonnenten senden
// -------------------------------------------------------------
function sendPushNotification(title, body) {
    const payload = JSON.stringify({ title, body });
    pushSubscriptions.forEach((sub, index) => {
        webpush.sendNotification(sub, payload).catch(err => {
            if (err.statusCode === 410 || err.statusCode === 404) {
                pushSubscriptions.splice(index, 1); // Abgelaufene Subscriptions entfernen
            }
        });
    });
}

// -------------------------------------------------------------
// Automatische Prüfung alle 30 Sekunden im Backend
// -------------------------------------------------------------
async function pollAndCheckChanges() {
    try {
        const lessons = await fetchTimetableFromUntis();
        const currentSpecialLessons = [];

        lessons.forEach(lesson => {
            const txt = `${lesson.substText || ''} ${lesson.activityType || ''}`.toLowerCase();
            const teacher = lesson.te?.[0]?.name || '';
            
            const isEigenarbeit = teacher === '---' || teacher === '' || teacher === '-' || txt.includes('eigenarbeit') || txt.includes('eva');
            const isEntfall = txt.includes('entfall') || lesson.code === 'cancelled';

            if (isEigenarbeit || isEntfall) {
                const typeStr = isEntfall ? 'Entfall' : 'Eigenarbeit';
                const subject = lesson.su?.[0]?.longname || lesson.su?.[0]?.name || 'Unterricht';
                const dateStr = formatDate(lesson.date);
                const timeStr = formatTime(lesson.startTime);
                
                // Eindeutiger Schlüssel zur Identifikation
                const uniqueKey = `${lesson.date}_${lesson.startTime}_${subject}_${typeStr}`;

                currentSpecialLessons.push({
                    key: uniqueKey,
                    title: `Planänderung: ${typeStr}`,
                    body: `${subject} am ${dateStr} um ${timeStr} Uhr (${typeStr})`
                });
            }
        });

        // Beim ersten Serverstart den Ist-Zustand merken (kein Notification-Spam)
        if (isFirstPoll) {
            currentSpecialLessons.forEach(item => knownLessonKeys.add(item.key));
            isFirstPoll = false;
            return;
        }

        // Nur WIRKLICH NEUE Einträge benachrichtigen
        currentSpecialLessons.forEach(item => {
            if (!knownLessonKeys.has(item.key)) {
                knownLessonKeys.add(item.key);
                sendPushNotification(item.title, item.body);
            }
        });

    } catch (err) {
        console.error("Polling-Fehler:", err.message);
    }
}

// Intervall: Alle 30 Sekunden (30000 ms)
setInterval(pollAndCheckChanges, 30000);

// -------------------------------------------------------------
// API Endpunkte für Push & Test
// -------------------------------------------------------------
app.get('/api/vapid-key', (req, res) => {
    res.json({ publicKey: publicVapidKey });
});

app.post('/api/subscribe', (req, res) => {
    const subscription = req.body;
    if (!pushSubscriptions.some(s => s.endpoint === subscription.endpoint)) {
        pushSubscriptions.push(subscription);
    }
    res.status(201).json({ success: true });
});

// TEST-BENACHRICHTIGUNG: Schickt alle aktuellen Eigenarbeiten einmalig raus
app.post('/api/test-notification', async (req, res) => {
    try {
        const lessons = await fetchTimetableFromUntis();
        const eigenarbeiten = lessons.filter(lesson => {
            const txt = `${lesson.substText || ''} ${lesson.activityType || ''}`.toLowerCase();
            const teacher = lesson.te?.[0]?.name || '';
            return teacher === '---' || teacher === '' || teacher === '-' || txt.includes('eigenarbeit') || txt.includes('eva');
        });

        if (eigenarbeiten.length === 0) {
            sendPushNotification("Test: Eigenarbeit", "Aktuell liegen keine Eigenarbeiten vor.");
        } else {
            eigenarbeiten.forEach(l => {
                const subject = l.su?.[0]?.longname || l.su?.[0]?.name || 'Unterricht';
                const dateStr = formatDate(l.date);
                const timeStr = formatTime(l.startTime);
                sendPushNotification(
                    `Test: Eigenarbeit in ${subject}`,
                    `Am ${dateStr} um ${timeStr} Uhr (Eigenarbeit)`
                );
            });
        }
        res.json({ success: true, count: eigenarbeiten.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/timetable', async (req, res) => {
    try {
        const data = await fetchTimetableFromUntis();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Stundenplan-Fehler", details: error.message });
    }
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));

export default app;