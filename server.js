const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'events.db');
const EVENTS_JSON_PATH = path.join(__dirname, 'events.json');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'cbcnadmin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMeCBCN!';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const activeSessions = new Map();

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

async function seedFromJsonIfNeeded() {
  await runAsync(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      image TEXT
    )
  `);

  const countRow = await getAsync('SELECT COUNT(*) AS count FROM events');
  if (countRow && countRow.count > 0) {
    return;
  }

  const file = fs.readFileSync(EVENTS_JSON_PATH, 'utf-8');
  const parsed = JSON.parse(file);
  const seedEvents = Array.isArray(parsed.events) ? parsed.events : [];

  for (const event of seedEvents) {
    await runAsync(
      `INSERT INTO events (title, date, time, location, description, category, image)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.title,
        event.date,
        event.time,
        event.location,
        event.description,
        event.category,
        event.image || null
      ]
    );
  }
}

function createSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function clearExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of activeSessions.entries()) {
    if (session.expiresAt <= now) {
      activeSessions.delete(token);
    }
  }
}

function requireAdminAuth(req, res, next) {
  clearExpiredSessions();
  const authHeader = req.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token || !activeSessions.has(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const session = activeSessions.get(token);
  if (session.expiresAt <= Date.now()) {
    activeSessions.delete(token);
    res.status(401).json({ error: 'Session expired' });
    return;
  }

  req.adminUser = session.username;
  next();
}

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});
app.use(express.static(__dirname));

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = createSessionToken();
  activeSessions.set(token, {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS
  });

  res.json({
    token,
    expiresInMs: SESSION_TTL_MS,
    username
  });
});

app.post('/api/admin/logout', requireAdminAuth, (req, res) => {
  const authHeader = req.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  activeSessions.delete(token);
  res.status(204).end();
});

app.get('/api/events', async (_req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM events ORDER BY date ASC, time ASC');
    res.json({ events: rows });
  } catch (error) {
    console.error('Failed to load events:', error);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

app.post('/api/events', requireAdminAuth, async (req, res) => {
  const { title, date, time, location, description, category, image = null } = req.body;

  if (!title || !date || !time || !location || !description || !category) {
    res.status(400).json({
      error: 'Missing required fields: title, date, time, location, description, category'
    });
    return;
  }

  try {
    const result = await runAsync(
      `INSERT INTO events (title, date, time, location, description, category, image)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [title, date, time, location, description, category, image]
    );

    const created = await getAsync('SELECT * FROM events WHERE id = ?', [result.lastID]);
    res.status(201).json({ event: created });
  } catch (error) {
    console.error('Failed to create event:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

app.put('/api/events/:id', requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  const { title, date, time, location, description, category, image = null } = req.body;

  if (!title || !date || !time || !location || !description || !category) {
    res.status(400).json({
      error: 'Missing required fields: title, date, time, location, description, category'
    });
    return;
  }

  try {
    const existing = await getAsync('SELECT id FROM events WHERE id = ?', [id]);
    if (!existing) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    await runAsync(
      `UPDATE events
       SET title = ?, date = ?, time = ?, location = ?, description = ?, category = ?, image = ?
       WHERE id = ?`,
      [title, date, time, location, description, category, image, id]
    );

    const updated = await getAsync('SELECT * FROM events WHERE id = ?', [id]);
    res.json({ event: updated });
  } catch (error) {
    console.error('Failed to update event:', error);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

app.delete('/api/events/:id', requireAdminAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await getAsync('SELECT id FROM events WHERE id = ?', [id]);
    if (!existing) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    await runAsync('DELETE FROM events WHERE id = ?', [id]);
    res.status(204).end();
  } catch (error) {
    console.error('Failed to delete event:', error);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

seedFromJsonIfNeeded()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CBCN site running on http://localhost:${PORT}`);
      console.log('Admin login URL: /admin-portal-cbcn.html');
    });
  })
  .catch((error) => {
    console.error('Database initialization failed:', error);
    process.exit(1);
  });
