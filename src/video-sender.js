// Runs in an isolated, local Chromium page. It never receives website cookies.
export function installVideoSender() {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  document.body.append(canvas);
  const context = canvas.getContext('2d', { alpha: false });
  const stream = canvas.captureStream(30);
  const peers = new Map();
  let lastFrame = Date.now();
  let generation = 0;
  window.videoSender = {
    async draw(data) {
      const current = generation;
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = 'data:image/jpeg;base64,' + data;
      });
      if (current !== generation) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      lastFrame = Date.now();
    },
    close(id) {
      peers.get(id)?.close();
      peers.delete(id);
    },
    async answer({ id, offer }) {
      const peer = new RTCPeerConnection({ iceServers: [] });
      peers.set(id, peer);
      try {
        await peer.setRemoteDescription(offer);
        const sender = peer.addTrack(stream.getVideoTracks()[0], stream);
        const parameters = sender.getParameters();
        parameters.encodings = [{ maxBitrate: 4000000, maxFramerate: 30 }];
        await sender.setParameters(parameters);
        await peer.setLocalDescription(await peer.createAnswer());
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error('ICE gathering timed out')); }, 5000);
          function cleanup() { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); }
          function changed() { if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); } }
          peer.addEventListener('icegatheringstatechange', changed);
          changed();
        });
        return peer.localDescription.toJSON();
      } catch (error) {
        window.videoSender.close(id);
        throw error;
      }
    },
  };
  // Blank a stale stream even if the Node process stops responding.
  setInterval(() => {
    if (Date.now() - lastFrame > 3000) {
      generation++;
      context.fillStyle = '#071725';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, 500);
}
