/* ES5: the TV renders the website through the authenticated PC gateway. */
(function () {
  'use strict';
  var frame = document.getElementById('page');
  var notice = document.getElementById('notice');
  var current = null;
  function hide() {
    if (current !== null) frame.src = 'about:blank';
    current = null;
    frame.style.display = 'none';
    notice.style.display = 'flex';
  }
  function poll() {
    var request = new XMLHttpRequest();
    var done = false;
    function finish() { if (done) return false; done = true; setTimeout(poll, 2000); return true; }
    function fail() { if (finish()) hide(); }
    request.open('GET', '/__queue/status?t=' + Date.now(), true);
    request.timeout = 5000;
    request.onerror = request.ontimeout = fail;
    request.onload = function () {
      if (!finish()) return;
      var state;
      try { if (request.status !== 200) throw new Error(); state = JSON.parse(request.responseText); } catch (error) { hide(); return; }
      if (state.mode !== 'direct') { window.location.replace(state.returnUrl); return; }
      if (!state.ready) { hide(); return; }
      var next = state.revision + ':' + state.path;
      if (current !== next) { frame.src = state.path; current = next; }
      frame.style.display = 'block';
      notice.style.display = 'none';
    };
    request.send();
  }
  document.getElementById('fullscreen').onclick = function () {
    var root = document.documentElement;
    var enter = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
    if (enter) { try { var result = enter.call(root); if (result && result.catch) result.catch(function () {}); } catch (error) {} }
  };
  setTimeout(function () { document.body.className = 'immersive'; }, 12000);
  poll();
}());
