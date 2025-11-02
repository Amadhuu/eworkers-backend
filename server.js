// server.js — Final Phase 2B (CRON + Cleanup)
require("dotenv").config();
// ✅ Force Redeploy Test — Phase 2B confirmed
const express = require("express");
const cors = require("cors");
const path = require("path");
const pool = require("./db");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

console.log("✅ Connected to database:", process.env.DATABASE_URL);

// --- Health check ---
app.get("/", (req, res) => res.send("E-Workers backend running 👍"));

// --- Fetch logs for Dashboard ---
app.get("/api/logs", async (req, res) => {
  try {
    const q = `
      SELECT id, group_name, account_owner, account_worker, account_type,
             date_worked AS work_date, minutes_worked, earnings_naira
      FROM logs
      ORDER BY date_worked DESC, id DESC
    `;
    const r = await pool.query(q);
    res.json(r.rows);
  } catch (err) {
    console.error("❌ Error fetching logs:", err);
    res.status(500).json({ error: "Error fetching logs" });
  }
});


// ================================================================
// 🟩 PROGRESS SEND (Manual from Floater)
// ================================================================
app.post("/api/progress/send", async (req, res) => {
  try {
    const { group, owner, worker, cycle, date, minutes = 0, hours = 0 } = req.body;

    if (!worker || !date) {
      return res.status(400).json({ message: "Missing worker or date" });
    }

    const mins = Math.round(minutes);
    const earnings = Math.round((minutes / 60) * 2000);

    await pool.query(
      `INSERT INTO logs
       (group_name, account_owner, account_worker, account_type, date_worked, minutes_worked, earnings_naira)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [group || "ADS", owner || "", worker || "", cycle || "us", date, mins, earnings]
    );

    console.log("✅ Progress stored:", { worker, date, minutes, earnings });
    res.json({ message: "Progress saved ✅", stored: { worker, date, minutes, earnings } });
  } catch (err) {
    console.error("❌ Error saving Floater progress:", err);
    res.status(500).json({ message: "Error saving progress", details: err.message });
  }
});


// ================================================================
// 🟩 MANUAL ARCHIVE TRIGGER (from Floater payload)
// ================================================================
app.post("/api/archive/run", async (req, res) => {
  try {
    const { group, owner, worker, cycle, date, minutes = 0 } = req.body;

    console.log("🗄️ Archive trigger received:", { worker, owner, date, minutes, cycle, group });

    const earnings = Math.round((minutes / 60) * 2000);

    await pool.query(
      `INSERT INTO logs
       (group_name, account_owner, account_worker, account_type, date_worked, minutes_worked, earnings_naira)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [group || "ADS", owner || "", worker || "", "ARCHIVE", date, minutes, earnings]
    );

    console.log(`✅ Archive saved for ${worker || "N/A"} (${date})`);
    res.json({ message: "Archive completed ✅", saved: { worker, date, minutes } });
  } catch (err) {
    console.error("❌ Archive error:", err);
    res.status(500).json({ message: "Error saving archive", details: err.message });
  }
});


// ================================================================
// 🟩 CRON JOB — SERVER AUTO-ARCHIVE (07:55 AM WAT Daily) + PING-BACK
// ================================================================
const axios = require("axios"); // <== Add near top if not already imported

cron.schedule(
  "55 7 * * *",
  async () => {
    const today = new Date().toISOString().split("T")[0];
    console.log("🕗 CRON: Starting daily auto-archive at 07:55 AM WAT →", today);

    try {
      // Get all unique workers
      const workers = await pool.query(`
        SELECT DISTINCT account_worker, account_owner, group_name, account_type
        FROM logs
        WHERE account_worker IS NOT NULL AND account_worker <> ''
      `);

      for (const row of workers.rows) {
        const { account_worker, account_owner, group_name, account_type } = row;

        // Check if worker already has today's log
        const existing = await pool.query(
          `SELECT 1 FROM logs WHERE account_worker=$1 AND date_worked=$2`,
          [account_worker, today]
        );

        if (existing.rowCount === 0) {
          // Insert 0-minute archive
          await pool.query(
            `INSERT INTO logs
             (group_name, account_owner, account_worker, account_type, date_worked, minutes_worked, earnings_naira)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [group_name, account_owner, account_worker, account_type, today, 0, 0]
          );
          console.log(`🗄️ Auto-archived zero entry for ${account_worker}`);
        }
      } 

      console.log("✅ Daily auto-archive completed successfully");
      updateCronHealth(today, workers.rows.length, true);

      // Count inserted entries for status tracking
      const insertedCount = workers.rows.length; // approximate
      updateCronHealth(today, insertedCount, true);

            // Update ping memory
      lastArchivePing = { status: "ARCHIVE_COMPLETE", date: today };
      console.log("📡 Ping status updated for Floater:", lastArchivePing);


      // 🟩 STEP 2: PING BACK TO FLOATER CLIENTS
      const floaterEndpoint = "http://127.0.0.1:3000/api/ping/archive"; // Floater local listener (Electron)

      try {
        const pingResponse = await axios.post(floaterEndpoint, {
          status: "ARCHIVE_COMPLETE",
          date: today,
        });
        console.log("📡 Ping-back sent to Floater:", pingResponse.data);
        updateCronHealth(today, workers.rows.length, true);
        resetPingStatus();
      } catch (pingErr) {
        console.warn("⚠️ Could not reach Floater for ping-back:", pingErr.message);
        updateCronHealth(today, 0, false, pingErr.message);
      }
    } catch (err) {
      console.error("❌ CRON auto-archive error:", err);
    }
  },
  {
    timezone: "Africa/Lagos",
  }
);

// ================================================================
// 🟩 PING STATUS ROUTE — Floater checks here for CRON completion
// ================================================================
let lastArchivePing = { status: "IDLE", date: null }; 

function resetPingStatus(delayMs = 5 * 60 * 1000) { // reset after 5 min
  setTimeout(() => {
    lastArchivePing = { status: "IDLE", date: null };
    console.log("🔁 Ping status reset to IDLE");
  }, delayMs);
}

// Whenever CRON finishes, update this variable (we’ll patch below)
app.get("/api/ping/archive-status", (req, res) => {
  res.json(lastArchivePing);
}); 

// ================================================================
// 🟩 START SERVER
// ================================================================
const PORT = process.env.PORT || 5000;

// ================================================================
// 🟩 CRON HEALTH STATUS ENDPOINT — Phase 2D Diagnostic
// ================================================================
let lastCronRun = {
  date: null,
  inserted: 0,
  pingSuccess: false,
  lastPingError: null,
};

// Small helper to update cron run info
function updateCronHealth(date, insertedCount, pingStatus, errorMsg = null) {
  lastCronRun = {
    date,
    inserted: insertedCount,
    pingSuccess: pingStatus,
    lastPingError: errorMsg,
  };
  console.log("📊 Updated CRON health:", lastCronRun);
}

// Add GET endpoint for diagnostics
app.get("/api/cron/status", (req, res) => {
  res.json({
    lastRun: lastCronRun.date || "No CRON run recorded yet",
    zeroMinuteInserts: lastCronRun.inserted,
    pingSuccess: lastCronRun.pingSuccess,
    pingError: lastCronRun.lastPingError,
  });
});

app.listen(PORT, () => console.log(`🚀 Backend live on port ${PORT}`));
