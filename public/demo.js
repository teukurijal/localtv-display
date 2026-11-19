function tick() { document.getElementById('clock').textContent = new Date().toLocaleTimeString('id-ID'); }
tick();
setInterval(tick, 1000);
