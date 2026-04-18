// Live clock in the navbar
(function () {
  function updateClock() {
    const el = document.getElementById('clock');
    if (el) {
      const now = new Date();
      el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  }
  updateClock();
  setInterval(updateClock, 1000);
})();
