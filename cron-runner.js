// cron-runner.js
const axios = require("axios");
(async () => {
  try {
    const today = new Date().toISOString().split("T")[0];
    console.log("🕗 Running Render CRON for auto-archive", today);
    const res = await axios.post(
      "https://eworkers-backend.onrender.com/api/archive/run",
      { date: today, status: "CRON_TRIGGER", minutes: 0 }
    );
    console.log("✅ CRON archive ping sent:", res.data);
  } catch (err) {
    console.error("❌ CRON job failed:", err.message);
  }
})();
