// app.js — E-Workers Welcome Hub
console.log("🌌 Welcome Hub loaded successfully.");

document.addEventListener("DOMContentLoaded", () => {
  const floaterBtn = document.getElementById("downloadFloater");

  if (floaterBtn) {
    floaterBtn.addEventListener("click", (e) => {
      e.preventDefault();
      alert("📦 Floater Tracker download feature coming soon!");
    });
  }
});