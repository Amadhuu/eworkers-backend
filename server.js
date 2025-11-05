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
// 🟩 PROGRESS SEND (Manual from Floater) — Duplicate-Proof
// ================================================================
app.post("/api/progress/send", async (req, res) => {
  try {
    const { group, owner, worker, cycle, date, minutes = 0, hours = 0 } = req.body;
    if (!worker || !date) return res.status(400).json({ message: "Missing worker or date" });

    const mins = parseFloat(minutes.toFixed(2)); // ✅ Preserve fractional precision
    const earnings = Math.round((minutes / 60) * 2000);
    const source_type = req.body.source_type || "floater"; // ✅ Fix source type

    await pool.query(
      `
      INSERT INTO logs (
        group_name, account_owner, account_worker, account_type,
        date_worked, minutes_worked, earnings_naira, source_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT ON CONSTRAINT logs_unique_record
      DO UPDATE SET
        minutes_worked = EXCLUDED.minutes_worked,
        earnings_naira = EXCLUDED.earnings_naira,
        account_type   = EXCLUDED.account_type,
        source_type    = EXCLUDED.source_type;
      `,
      [group || "ADS", owner || "", worker || "", cycle || "us", date, mins, earnings, source_type]
    );

    console.log(
      `\x1b[32m📦 [${group || "—"} | ${owner || "—"} | ${worker || "—"} | ${mins}m | ${source_type} | ${date}] ✅\x1b[0m`
    );

    res.json({ message: "Progress stored successfully ✅", data: { worker, date, mins, earnings, source_type } });
  } catch (err) {
    console.error("❌ Error saving Floater progress:", err);
    res.status(500).json({ message: "Error saving progress", details: err.message });
  }
});

// ================================================================
// 🟩 MANUAL ARCHIVE TRIGGER (from Floater payload) — Duplicate-Proof
// ================================================================
app.post("/api/archive/run", async (req, res) => {
  try {
    const { group, owner, worker, cycle, date, minutes = 0 } = req.body;
    if (!worker || !date) return res.status(400).json({ message: "Missing worker or date" });

    const earnings = Math.round((minutes / 60) * 2000);
    const source_type = req.body.source_type || "backend"; // ✅ Set fallback

    await pool.query(
      `
      INSERT INTO logs (
        group_name, account_owner, account_worker, account_type,
        date_worked, minutes_worked, earnings_naira, source_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT ON CONSTRAINT logs_unique_record
      DO UPDATE SET
        minutes_worked = EXCLUDED.minutes_worked,
        earnings_naira = EXCLUDED.earnings_naira,
        account_type   = EXCLUDED.account_type,
        source_type    = EXCLUDED.source_type;
      `,
      [group || "ADS", owner || "", worker || "", "ARCHIVE", date, minutes, earnings, source_type]
    );

    // ✅ Register or update active registry
    await pool.query(
      `
      INSERT INTO active_registry (group_name, account_owner, account_worker, last_active)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (group_name, account_owner, account_worker)
      DO UPDATE SET last_active = NOW();
      `,
      [group || "ADS", owner || "", worker || ""]
    );

    console.log(
      `\x1b[36m📦 [${group || "—"} | ${owner || "—"} | ${worker || "—"} | ${minutes}m | ${source_type} | ${date}] ✅\x1b[0m`
    );
    res.json({ message: "Archive completed ✅", saved: { worker, date, minutes, source_type } });
  } catch (err) {
    console.error("❌ Archive error:", err);
    res.status(500).json({ message: "Error saving archive", details: err.message });
  }
});

// ================================================================
// 🧩 Helper — Get last known account_type for a worker
// ================================================================
async function getLastKnownAccountType(worker, owner, group) {
  try {
    const q = `
      SELECT account_type
      FROM logs
      WHERE account_worker = $1
        AND account_owner = $2
        AND group_name = $3
        AND minutes_worked > 0
        AND account_type IS NOT NULL
      ORDER BY date_worked DESC
      LIMIT 1;
    `;
    const r = await pool.query(q, [worker, owner, group]);
    if (r.rowCount > 0) {
      console.log(`🧠 Found last known account_type for ${worker}: ${r.rows[0].account_type}`);
      return r.rows[0].account_type;
    } else {
      console.log(`⚪ No previous account_type found for ${worker} — defaulting to ARCHIVE`);
      return null;
    }
  } catch (err) {
    console.error("❌ Error fetching last known account type:", err.message);
    return null;
  }
}  
  

// ================================================================  
// 🧠 SMART CRON JOB — Auto-Archive Only Active Floater Workers (Diagnostic Enhanced)  
// ================================================================  
const axios = require("axios");
cron.schedule(  
  "55 7 * * *",  
  async () => {  
    // 🧭 SmartCRON cycle alignment — use previous day's date (8AM–8AM cycle)
    const now = new Date();
    // Shift back 1 day to represent the completed workday
    now.setDate(now.getDate() - 1);
    const today = now.toISOString().split("T")[0];
    console.log("📅 SMART CRON aligned workday →", today);  
    console.log("🧭 SMART CRON started → checking active_registry for active workers...");  
    console.log("🕗 SMART CRON: Starting daily auto-archive at 07:55 AM WAT →", today);  

    try {  
      // STEP 1: Pull only active Floater users (worked within last 7 days)  
      const activeWorkers = await pool.query(`  
        SELECT group_name, account_owner, account_worker  
        FROM active_registry  
        WHERE last_active >= NOW() - INTERVAL '7 days'  
      `);  

      console.log(`🧮 SMART CRON found ${activeWorkers.rowCount} active workers to process.`);  

      if (activeWorkers.rowCount === 0) {  
        console.log("⚠️ SMART CRON: No active workers found — nothing to archive today.");  
        updateCronHealth(today, 0, true);  
        return;  
      }  

      let inserted = 0, skipped = 0;  

      // STEP 2: Loop through each active worker and archive safely  
      for (const { group_name, account_owner, account_worker } of activeWorkers.rows) {  
        const exists = await pool.query(  
          `SELECT 1 FROM logs  
           WHERE account_worker=$1 AND account_owner=$2  
             AND group_name=$3 AND date_worked=$4`,  
          [account_worker, account_owner, group_name, today]  
        );  

        if (exists.rowCount > 0) {  
          skipped++;  
          console.log(`⏩ SMART CRON skipped ${account_worker} (${group_name}) — already logged today.`);  
          continue;  
        }  

        // 🧠 Step: Fetch last known account type before inserting
        const lastType = await getLastKnownAccountType(account_worker, account_owner, group_name);
        const effectiveType = lastType || "ARCHIVE";

        await pool.query(`
          INSERT INTO logs (
            group_name, account_owner, account_worker, account_type,
            date_worked, minutes_worked, earnings_naira, source_type
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [group_name, account_owner, account_worker, effectiveType, today, 0, 0, "cron"]);

        console.log(`✅ SMART CRON inserted 0-min record for ${account_worker} (${group_name}) [type=${effectiveType}]`);

        inserted++;    
      }  

      // STEP 3: Summary and update CRON health  
      console.log(`🏁 SMART CRON finished → total processed: ${activeWorkers.rowCount}, new inserts: ${inserted}, skipped: ${skipped}`);  
      updateCronHealth(today, inserted, true);  

      // STEP 4: PING Floater (optional, for local app sync)  
      lastArchivePing = { status: "ARCHIVE_COMPLETE", date: today };  
      console.log("📡 SMART CRON ping status updated for Floater:", lastArchivePing);  

      try {  
        await axios.post("http://127.0.0.1:3000/api/ping/archive", {  
          status: "ARCHIVE_COMPLETE",  
          date: today,  
        });  
        console.log("📡 SMART CRON ping-back sent successfully to Floater.");  
        resetPingStatus();  
      } catch (pingErr) {  
        console.warn("⚠️ SMART CRON could not reach Floater for ping-back:", pingErr.message);  
      }  

    } catch (err) {  
      console.error("❌ SMART CRON error:", err.message);  
      updateCronHealth(today, 0, false, err.message);  
    }  
  },  
  { timezone: "Africa/Lagos" }  
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
// 🧹 SMART SECURITY + AUTO-PRUNE — Phase 2F
// Cleans inactive registry entries & prevents duplicates
// Runs daily at 08:10 AM WAT (after CRON finishes)
// ================================================================

cron.schedule(
  "10 8 * * *", // 8:10 AM WAT
  async () => {
    const now = new Date().toISOString().split("T")[0];
    console.log(`🧹 AUTO-PRUNE: Checking for inactive workers on ${now}`);

    try {
      // 1️⃣  Remove entries dormant > 30 days
      const prune = await pool.query(
        `DELETE FROM active_registry
         WHERE last_active < NOW() - INTERVAL '30 days'
         RETURNING group_name, account_owner, account_worker;`
      );

      if (prune.rowCount > 0) {
        console.log(`🧼 Removed ${prune.rowCount} inactive registry entries.`);
        prune.rows.forEach(r =>
          console.log(`   ⏳ ${r.account_worker} (${r.group_name} → ${r.account_owner}) removed.`)
        );
      } else {
        console.log("✅ Registry clean — no inactive workers to prune today.");
      }

      // 2️⃣  Verify no duplicates (shouldn’t happen, but safe check)
      await pool.query(`
        DELETE FROM active_registry a
        USING active_registry b
        WHERE a.ctid < b.ctid
          AND a.group_name = b.group_name
          AND a.account_owner = b.account_owner
          AND a.account_worker = b.account_worker;
      `);

      console.log("🧠 Duplicate registry check complete — OK.");

      // 3️⃣  Update CRON health report
      updateCronHealth(now, prune.rowCount, true);
    } catch (err) {
      console.error("❌ AUTO-PRUNE error:", err.message);
      lastPruneRun = {
      date: now,
      removed: 0,
      success: false,
      error: err.message,
    };
      updateCronHealth(now, 0, false, err.message);
    }
  },
  { timezone: "Africa/Lagos" }
);


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

// ✅ Move this outside the function
let lastPruneRun = {
  date: null,
  removed: 0,
  success: false,
  error: null,
};

function updateCronHealth(date, insertedCount, pingStatus, errorMsg = null) {
  lastCronRun = {
    date,
    inserted: insertedCount,
    pingSuccess: pingStatus,
    lastPingError: errorMsg,
  };
  console.log("📊 Updated CRON health:", lastCronRun);
}

// ================================================================
// 🧭 CRON STATUS ENDPOINT — Combined Archive + Auto-Prune Summary
// ================================================================
app.get("/api/cron/status", (req, res) => {
  res.json({
    archive: {
      lastRunDate: lastCronRun.date || "No archive run yet",
      totalProcessed: lastCronRun.inserted || 0,
      pingSuccess: lastCronRun.pingSuccess || false,
      lastPingError: lastCronRun.lastPingError || null,
      summary: `🕗 ARCHIVE → ${lastCronRun.date || "N/A"} | ✅ Inserts: ${
        lastCronRun.inserted || 0
      } | 📡 Ping: ${lastCronRun.pingSuccess ? "OK" : "FAILED"}${
        lastCronRun.lastPingError ? " ⚠️ " + lastCronRun.lastPingError : ""
      }`,
    },
    prune: {
      lastRunDate: lastPruneRun.date || "No prune run yet",
      totalRemoved: lastPruneRun.removed || 0,
      success: lastPruneRun.success || false,
      lastError: lastPruneRun.error || null,
      summary: `🧹 PRUNE → ${lastPruneRun.date || "N/A"} | 🗑️ Removed: ${
        lastPruneRun.removed || 0
      } | Status: ${lastPruneRun.success ? "OK" : "FAILED"}${
        lastPruneRun.error ? " ⚠️ " + lastPruneRun.error : ""
      }`,
    },
  });
}); 

// ================================================================
// 🧭 WORKER REGISTRY ENDPOINT — Phase 3B
// Provides group → owner mapping for Floater dropdowns
// ================================================================
app.get("/api/registry", async (req, res) => {
  try {
    const q = `
      SELECT group_name, account_owner
      FROM worker_registry
      ORDER BY group_name, account_owner;
    `;
    const result = await pool.query(q);

    // Transform rows into structured { ADS: [...], IJS: [...], MRK: [...], SAZ: [...] }
    const registry = {};
    result.rows.forEach(r => {
      const group = r.group_name?.trim() || "Unknown";
      const owner = r.account_owner?.trim() || "(unspecified)";
      if (!registry[group]) registry[group] = [];
      if (!registry[group].includes(owner)) registry[group].push(owner);
    });

    console.log("📦 Registry fetched successfully — groups:", Object.keys(registry).length);
    res.json({ registry });
  } catch (err) {
    console.error("❌ Error fetching worker registry:", err.message);
    res.status(500).json({ error: "Failed to fetch worker registry" });
  }
});

app.listen(PORT, () => console.log(`🚀 Backend live on port ${PORT}`));
