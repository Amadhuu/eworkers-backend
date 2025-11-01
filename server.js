// server.js
require('dotenv').config(); // optional if you use .env for DB settings
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db'); // db.js will export a pg Pool
console.log("Database in use:", process.env.DATABASE_URL);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// simple health
app.get('/', (req, res) => res.send('Server is running 👍'));

// fetch logs
app.get('/api/logs', async (req, res) => {
  try {
    const q = `
  SELECT id, group_name, account_owner, account_worker, account_type,
         date_worked AS work_date,
         minutes_worked, earnings_naira
  FROM logs
  ORDER BY date_worked DESC, id DESC
`;
    const r = await pool.query(q);
    res.json(r.rows);
  } catch (err) {
    console.error('❌ Error fetching logs:', err);
    res.status(500).json({ error: 'Error fetching logs' });
  }
});

// Handle progress send from Floater
app.post('/api/progress/send', async (req, res) => {
  try {
    const { group, owner, worker, cycle, date, minutes, hours } = req.body;

    if (!worker || !date) {
      return res.status(400).json({ message: 'Missing worker or date' });
    }

    // Normalize and calculate earnings
    const mins = Math.round(minutes || 0);
    const earnings = Math.round((minutes / 60) * 2000); // adjust your rate if needed

    // Insert into database (map Floater fields to DB columns)
    await pool.query(
      `INSERT INTO logs
      (group_name, account_owner, account_worker, account_type, date_worked, minutes_worked, earnings_naira)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [group || 'ADS', owner || '', worker || '', cycle || '', date, mins, earnings]
    );

    console.log('✅ Floater progress stored:', { worker, date, minutes, earnings });
    res.json({ message: 'Progress saved ✅', stored: { worker, date, minutes, earnings } });
  } catch (err) {
    console.error('❌ Error saving Floater progress:', err);
    res.status(500).json({ message: 'Error saving Floater progress', details: err.message });
  }
});

// === Floater Compatibility Routes ==

// Handle progress send from Floater
app.post('/api/progress/send', async (req, res) => {
  try {
    const { group, owner, worker, cycle, date, minutes, hours } = req.body;

    if (!worker || !date) {
      return res.status(400).json({ message: 'Missing worker or date' });
    }

const mins = Math.round(minutes_worked);
await pool.query(
  `INSERT INTO logs
  (group_name, account_owner, account_worker, account_type, date_worked, minutes_worked, earnings_naira)
  VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  [group || 'ADS', account_owner || '', account_worker || '', account_type || '', date_worked, mins || 0, earnings_naira || 0]
);


    console.log('📥 Floater progress stored:', { worker, date, minutes, earnings });
    res.json({ message: 'Progress received ✅', stored: { worker, date, minutes, earnings } });
  } catch (err) {
    console.error('❌ Error saving Floater progress:', err);
    res.status(500).json({ message: 'Error saving Floater progress' });
  }
});

// Handle auto-archive trigger from Floater
app.post('/api/archive/run', async (req, res) => {
  try {
    const { group, owner, worker, cycle, date, minutes } = req.body;
    console.log('🗄️ Archive triggered from Floater:', { worker, date, minutes });
    res.json({ message: 'Archive logged ✅', data: req.body });
  } catch (err) {
    console.error('❌ Archive endpoint error:', err);
    res.status(500).json({ message: 'Error processing archive' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));