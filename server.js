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

// accept logs from tracker
app.post('/api/logs', async (req, res) => {
  try {
    const {
      group,
      account_owner,
      account_worker,
      account_type,
      work_date,
      minutes_worked,
      earnings_naira
    } = req.body;

    // validate
    if (!account_worker || !work_date) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Insert (maps client names to DB columns)
    await pool.query(
      `INSERT INTO logs
      (group_name, account_owner, account_worker, account_type, date_worked, minutes_worked, earnings_naira)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [group || 'ADS', account_owner || '', account_worker || '', account_type || '', date_worked, minutes_worked || 0, earnings_naira || 0]
    );

    res.json({ message: 'Log saved ✅' });
  } catch (err) {
    console.error('❌ Error saving log:', err);
    res.status(500).json({ message: 'Error saving log' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));