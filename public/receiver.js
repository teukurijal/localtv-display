/* ES5 syntax and XMLHttpRequest keep the receiver usable on older TV browsers. */
(function () {
  'use strict';
  var match = window.location.pathname.match(/\/tv\/([123])/);
  var id = match ? match[1] : '1';
  var display = document.getElementById('display');
  var offline = document.getElementById('offline');
  var heading = document.getElementById('status-heading');
  var message = document.getElementById('status-message');
  var videoElement = document.getElementById('video');
  var modeButton = document.getElementById('stream-mode');
  var streamStatus = document.getElementById('stream-status');
  var video = new window.QueueVideo(id, videoElement, function () {
    display.style.display = 'none';
    videoElement.style.display = 'block';
    offline.style.display = 'none';
    streamStatus.textContent = 'Live video';
  }, function () { streamStatus.textContent = 'Compatibility mode'; });
  modeButton.hidden = !video.supported;
  function modeLabel() { modeButton.textContent = video.enabled() ? 'Use compatibility mode' : 'Try video'; }
  modeButton.onclick = function () { video.toggle(); modeLabel(); };
  modeLabel();
  var revision = null;
  var failures = 0;
  var wakeLock = null;
  document.getElementById('receiver-id').textContent = 'TV ' + id + ' · Automatically reconnects';

  function unavailable(title, detail) {
    video.reset();
    display.style.display = 'none';
    display.removeAttribute('src');
    offline.style.display = 'table';
    heading.textContent = title;
    message.textContent = detail;
  }
  function schedule(interval) { window.setTimeout(poll, interval); }
  function retry() {
    failures += 1;
    unavailable('Waiting for the PC', 'Check the PC service and Wi-Fi. Reconnecting automatically…');
    schedule(Math.min(5000, 1000 + failures * 500));
  }
  function frame(interval) {
    var next = new Image();
    var finished = false;
    var timeout = window.setTimeout(function () { finish(false); }, 5000);
    function finish(ok) {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      next.onload = null;
      next.onerror = null;
      if (ok) {
        display.src = next.src;
        display.style.display = video.live() ? 'none' : 'block';
        if (!video.live()) streamStatus.textContent = video.pending() ? 'Connecting video · compatibility mode' : 'Compatibility mode';
        offline.style.display = 'none';
        failures = 0;
        schedule(interval);
      } else { retry(); }
    }
    next.onload = function () { finish(true); };
    next.onerror = function () { finish(false); };
    next.src = '/api/tv/' + id + '/frame.jpg?t=' + Date.now();
  }
  function poll() {
    var request = new XMLHttpRequest();
    var done = false;
    request.open('GET', '/api/tv/' + id + '/status?t=' + Date.now() + (video.session() ? '&video=' + encodeURIComponent(video.session()) : ''), true);
    request.timeout = 5000;
    function fail() { if (!done) { done = true; retry(); } }
    request.onerror = fail;
    request.ontimeout = fail;
    request.onload = function () {
      if (done) return;
      done = true;
      if (request.status !== 200) return retry();
      var state;
      try { state = JSON.parse(request.responseText); } catch (error) { return retry(); }
      if (revision !== null && revision !== state.revision) { window.location.reload(); return; }
      revision = state.revision;
      if (state.mode === 'direct' && !/[?&]mode=stream(?:&|$)/.test(location.search)) { window.location.replace('/tv/' + id); return; }
      failures = 0;
      document.getElementById('tv-name').textContent = state.name;
      if (state.available) {
        if (video.session() && !state.video) video.reset();
        video.start();
        video.check();
        if (video.live()) schedule(1000);
        else frame(state.interval || 1000);
      }
      else {
        var title = state.state === 'stopped' ? 'Display is paused' : state.state === 'awaiting-approval' ? 'Your queue will appear shortly' : 'Preparing your display';
        unavailable(title, 'The operator can check this display on the PC. This screen will update automatically.');
        schedule(1500);
      }
    };
    request.send();
  }
  function requestWakeLock() {
    if (navigator.wakeLock && !wakeLock && document.visibilityState === 'visible') {
      navigator.wakeLock.request('screen').then(function (lock) {
        wakeLock = lock;
        lock.addEventListener('release', function () { wakeLock = null; });
      }).catch(function () {});
    }
  }
  document.getElementById('fullscreen').onclick = function () {
    var element = document.documentElement;
    var enter = element.requestFullscreen || element.webkitRequestFullscreen || element.msRequestFullscreen;
    if (enter) {
      try { var result = enter.call(element); if (result && result.catch) result.catch(function () {}); } catch (error) {}
    }
    requestWakeLock();
  };
  function fullscreenChanged() {
    document.body.className = (document.fullscreenElement || document.webkitFullscreenElement) ? 'immersive is-fullscreen' : 'immersive';
  }
  document.addEventListener('fullscreenchange', fullscreenChanged);
  document.addEventListener('webkitfullscreenchange', fullscreenChanged);
  document.addEventListener('visibilitychange', requestWakeLock);
  window.setTimeout(function () { document.body.className = 'immersive'; }, 12000);
  window.addEventListener('pagehide', function () { video.reset(); });
  requestWakeLock();
  poll();
}());
