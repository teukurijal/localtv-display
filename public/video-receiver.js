/* ES5 keeps this file parseable on older TVs; unsupported APIs use JPEG. */
(function () {
  'use strict';
  window.QueueVideo = function (id, video, onLive, onFallback) {
    var peer = null;
    var session = null;
    var generation = 0;
    var timer = null;
    var retryAt = 0;
    var enabled = !/[?&]mode=jpeg(?:&|$)/.test(location.search);
    var live = false;
    var pending = false;
    var lastBytes = 0;
    var lastProgress = 0;
    var checking = false;
    var supported = Boolean(window.RTCPeerConnection && window.Promise && 'srcObject' in video);

    function post(action, body) {
      return new Promise(function (resolve, reject) {
        var request = new XMLHttpRequest();
        request.open('POST', '/api/tv/' + id + '/video/' + action, true);
        request.setRequestHeader('Content-Type', 'application/json');
        request.timeout = 10000;
        request.onload = function () {
          if (request.status !== 200) return reject(new Error('Video unavailable'));
          try { resolve(JSON.parse(request.responseText)); } catch (error) { reject(error); }
        };
        request.onerror = request.ontimeout = function () { reject(new Error('Video connection failed')); };
        request.send(JSON.stringify(body));
      });
    }
    function reset(delay) {
      generation++;
      clearTimeout(timer);
      if (peer) peer.close();
      peer = null;
      if (session) post('close', { session: session }).catch(function () {});
      session = null;
      live = false;
      pending = false;
      checking = false;
      video.onplaying = null;
      video.srcObject = null;
      video.style.display = 'none';
      retryAt = Date.now() + (delay || 0);
      onFallback();
    }
    function start() {
      if (!supported || !enabled || peer || Date.now() < retryAt) return;
      var current = ++generation;
      pending = true;
      lastBytes = 0;
      lastProgress = Date.now();
      try {
        peer = new RTCPeerConnection({ iceServers: [] });
        var connection = peer;
        connection.addTransceiver('video', { direction: 'recvonly' });
        video.onplaying = function () {
          if (current !== generation) return;
          live = true;
          pending = false;
          lastProgress = Date.now();
          clearTimeout(timer);
          onLive();
        };
        connection.ontrack = function (event) {
          if (current !== generation) return;
          video.srcObject = event.streams[0] || new MediaStream([event.track]);
          var play = video.play();
          if (play && play.catch) play.catch(function () { if (current === generation) reset(30000); });
        };
        connection.onconnectionstatechange = connection.oniceconnectionstatechange = function () {
          if (current !== generation) return;
          if (/failed|closed|disconnected/.test(connection.connectionState || connection.iceConnectionState)) reset(30000);
        };
        timer = setTimeout(function () { if (current === generation) reset(30000); }, 15000);
        connection.createOffer().then(function (offer) {
          return connection.setLocalDescription(offer);
        }).then(function () {
          return new Promise(function (resolve, reject) {
            var timeout = setTimeout(function () { cleanup(); reject(new Error('ICE timeout')); }, 5000);
            function cleanup() { clearTimeout(timeout); connection.removeEventListener('icegatheringstatechange', changed); }
            function changed() { if (connection.iceGatheringState === 'complete') { cleanup(); resolve(); } }
            connection.addEventListener('icegatheringstatechange', changed);
            changed();
          });
        }).then(function () {
          if (current !== generation) throw new Error('Cancelled');
          return post('offer', { type: connection.localDescription.type, sdp: connection.localDescription.sdp });
        }).then(function (result) {
          if (current !== generation) { post('close', { session: result.session }).catch(function () {}); return; }
          session = result.session;
          return connection.setRemoteDescription(result.answer);
        }).catch(function () { if (current === generation) reset(30000); });
      } catch (error) { reset(30000); }
    }
    function check() {
      if (!live || !peer || checking) return;
      checking = true;
      var current = generation;
      peer.getStats().then(function (reports) {
        if (current !== generation) return;
        checking = false;
        var bytes = 0;
        reports.forEach(function (report) {
          if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) bytes += report.bytesReceived || 0;
        });
        if (bytes > lastBytes) { lastBytes = bytes; lastProgress = Date.now(); }
        else if (Date.now() - lastProgress > 6000) reset(30000);
      }).catch(function () { if (current === generation) reset(30000); });
    }
    return {
      start: start, reset: reset, check: check,
      live: function () { return live; },
      pending: function () { return pending; },
      session: function () { return session; },
      enabled: function () { return enabled && supported; },
      toggle: function () { enabled = !enabled; reset(); return enabled; },
      supported: supported
    };
  };
}());
