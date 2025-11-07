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
app.use("/downloads", express.static(path.join(__dirname,"public", "downloads")));

// ===============================================================
// 🧩 Dynamic Update Info System (Hybrid Auto-Update Backend)
// ===============================================================

const fs = require("fs");
const configPath = path.join(process.cwd(), "data", "update-config.json");

// --- GET: serve current update info ---
app.get("/api/update/check", (req, res) => {
  try {
    const channel = (req.query.channel || "stable").toLowerCase();
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!cfg[channel]) return res.status(404).json({ error: "Channel not found" });
    res.json(cfg[channel]);
  } catch (err) {
    console.error("⚠️ /api/update/check error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- POST: admin-only update of version info ---
app.post("/api/update/config", (req, res) => {
  try {
    const { token, channel, version, url, notes } = req.body;
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg[channel] = { version, url, notes };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    console.log(`✅ Update config modified for ${channel}:`, version);
    res.json({ ok: true, updated: cfg[channel] });
  } catch (err) {
    console.error("⚠️ /api/update/config error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

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
// 🧠 SMART CRON JOB — Auto-Archive Only Active Floater Workers (Hardened Phase 4)
// ================================================================
const axios = require("axios");

cron.schedule(
  "55 7 * * *",
  async () => {
    const now = new Date();
    now.setDate(now.getDate() - 1); // completed workday
    const today = now.toISOString().split("T")[0];
    console.log("📅 SMART CRON → aligned workday:", today);

    try {
      // STEP 1 — fetch active workers
      const activeWorkers = await pool.query(`
        SELECT group_name, account_owner, account_worker
        FROM active_registry
        WHERE last_active >= NOW() - INTERVAL '7 days'
      `);
      console.log(`🧮 Found ${activeWorkers.rowCount} active workers`);

      if (activeWorkers.rowCount === 0) {
        console.log("⚠️ No active workers — nothing to archive today");
        updateCronHealth(today, 0, true);
        return;
      }

      let archived = 0, skipped = 0;
      const processed = new Set();

      for (const row of activeWorkers.rows) {
        const { group_name, account_owner, account_worker } = row;
        const key = `${group_name}|${account_owner}|${account_worker}`;
        if (processed.has(key)) continue;
        processed.add(key);

        // 🧩 skip empty or invalid records
        if (!group_name || !account_owner || !account_worker) {
          console.warn("⚠️ Skipped invalid registry row:", row);
          skipped++;
          continue;
        }

        try {
          // check for sent record
          const sent = await pool.query(
            `SELECT 1 FROM logs
             WHERE account_worker=$1 AND account_owner=$2 AND group_name=$3 AND date_worked=$4
             AND source_type='floater'`,
            [account_worker, account_owner, group_name, today]
          );

          if (sent.rowCount === 0) {
            skipped++;
            console.log(`⏭️ ${account_worker} (${group_name}) — no sent record, skipped`);
            continue;
          }

          // fetch last known account type and update
          const lastType = await getLastKnownAccountType(account_worker, account_owner, group_name);
          const effectiveType = lastType || "ARCHIVE";

          await pool.query(
            `UPDATE logs
             SET account_type=$1, source_type='cron'
             WHERE account_worker=$2 AND account_owner=$3 AND group_name=$4 AND date_worked=$5`,
            [effectiveType, account_worker, account_owner, group_name, today]
          );

          archived++;
          console.log(`✅ Archived ${account_worker} (${group_name}) [type=${effectiveType}]`);

        } catch (innerErr) {
          console.error(`❌ Archive failed for ${account_worker}:`, innerErr.message);
          skipped++;
          continue;
        }
      }

      console.log(
        `🏁 SMART CRON Summary → ${today} | Archived:${archived} | Skipped:${skipped}`
      );
      updateCronHealth(today, archived, true);

      // STEP 2 — Ping Floater safely
      lastArchivePing = { status: "ARCHIVE_COMPLETE", date: today };
      let pingSent = false;

      try {
        const resp = await axios.post("http://127.0.0.1:3000/api/ping/archive", {
          status: "ARCHIVE_COMPLETE",
          date: today,
        });
        if (resp.status >= 200 && resp.status < 300) {
          pingSent = true;
          console.log("📡 Ping-back → Floater OK");
          resetPingStatus();
        } else {
          console.warn("⚠️ Ping-back non-200:", resp.status);
        }
      } catch (pingErr) {
        if (pingErr.response?.status === 400) {
          console.warn("⚠️ Ping-back 400 ignored (Floater not ready)");
        } else {
          console.warn("⚠️ Ping-back failed:", pingErr.message);
        }
        // optional retry after 60 s
        setTimeout(async () => {
          try {
            await axios.post("http://127.0.0.1:3000/api/ping/archive", {
              status: "ARCHIVE_COMPLETE",
              date: today,
            });
            console.log("📡 Retry ping → success");
          } catch (e) {
            console.warn("⚠️ Retry ping failed:", e.message);
          }
        }, 60 * 1000);
      }

    } catch (err) {
      console.error("❌ SMART CRON fatal error:", err.message);
      updateCronHealth(today, 0, false, err.message);
    } finally {
      console.log("🧭 SMART CRON finished gracefully (no unhandled rejections)");
    }
  },
  { timezone: "Africa/Lagos" }
);

// ================================================================
// 🟩 PING STATUS ROUTE — Floater checks here for CRON completion
// ================================================================
let lastArchivePing = { status: "IDLE", date: null }; 

function resetPingStatus(delayMs = 15 * 60 * 1000) { // keep active for 15 minutes
  setTimeout(() => {
    lastArchivePing = { status: "IDLE", date: null };
    console.log("🔁 Ping status reset to IDLE (after 15 mins)");
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

// ================================================================
// 🌍 Serve Dashboard Route — Phase 4 Integration
// ================================================================
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard", "index.html"));
});

app.get("/dashboard/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard", "index.html"));
});

app.listen(PORT, () => console.log(`🚀 Backend live on port ${PORT}`));
