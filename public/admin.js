const $ = (selector, parent = document) => parent.querySelector(selector);
const cards = new Map();
const previews = new Map();
let token = '';
let sessionRequest = null;
let state;
let busy = false;
let hydrated = false;
let activePreview = null;
let toastTimer;

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast${error ? ' error' : ''}`;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 10000 : 4500);
}

function ensureSession() {
  if (token) return Promise.resolve(token);
  // Initial polling and an early button click share one session request.
  if (!sessionRequest) {
    sessionRequest = (async () => {
      const response = await fetch('/api/admin/session', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (!response.ok || typeof result.token !== 'string' || !result.token) throw new Error(result.error || 'Unable to connect to the admin session.');
      token = result.token;
      return token;
    })().finally(() => { sessionRequest = null; });
  }
  return sessionRequest;
}

async function api(route, body) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestToken = await ensureSession();
    const response = await fetch(`/api/admin/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Admin-Token': requestToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(40000),
    });
    const result = await response.json();
    if (response.status === 401 && attempt === 0) {
      // The server rejects authentication before running the action, so this
      // single retry cannot repeat an executed control. Keep a newer token if
      // another in-flight request already renewed the session.
      if (token === requestToken) token = '';
      continue;
    }
    if (!response.ok) throw new Error(result.error || 'The request failed.');
    return result;
  }
}

async function perform(action, message) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const result = await action();
    state = await api('state');
    render();
    const failures = result?.results?.filter(item => !item.ok);
    if (failures?.length) toast(failures.map(item => `TV ${item.id}: ${item.error}`).join(' '), true);
    else if (message) toast(message);
  } catch (error) { toast(error.message, true); }
  finally {
    busy = false;
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    if (state) render();
  }
}

function receiverUrl(id) {
  return `${$('#lan-address').value || `http://PC-LAN-IP:${location.port}`}/tv/${id}`;
}

function syncAddresses() {
  for (const [id, card] of cards) $('.receiver-url', card).textContent = receiverUrl(id);
}

function populate() {
  $('#login-url').value = state.config.loginUrl;
  $('#fps').value = state.config.fps;
  // Preserve values changed outside the UI without silently replacing their quality setting.
  if (![...$('#quality').options].some(option => Number(option.value) === state.config.quality)) {
    $('#quality').add(new Option(`${state.config.quality}%`, String(state.config.quality)));
  }
  $('#quality').value = state.config.quality;
  for (const device of state.config.devices) {
    const form = $('.device-form', cards.get(device.id));
    for (const key of ['name', 'url', 'readySelector', 'resolution', 'refreshSeconds']) form.elements[key].value = device[key];
  }
}

function setPreview(id, url) {
  const card = cards.get(id);
  const old = previews.get(id);
  previews.set(id, url);
  const image = $('.preview-image', card);
  image.hidden = !url;
  $('.preview-empty', card).hidden = Boolean(url);
  $('.preview-label', card).hidden = !url;
  if (url) image.src = url;
  else image.removeAttribute('src');
  if (activePreview === id) {
    $('#large-preview').hidden = !url;
    if (url) $('#large-preview').src = url;
    else $('#large-preview').removeAttribute('src');
  }
  if (old) URL.revokeObjectURL(old);
}

function render() {
  $('#connected-count').textContent = `${state.devices.filter(device => device.connected || device.cast.state === 'casting').length} of 3 TVs connected`;
  $('#cast-all').disabled = busy || !state.config.devices.every(device => device.castSink) || !state.devices.every(device => device.frameAvailable);
  $('#stop-casts').disabled = busy || !state.devices.some(device => device.cast.state !== 'idle');
  const live = state.devices.filter(device => device.frameAvailable).length;
  $('#stream-count').textContent = `${live} live stream${live === 1 ? '' : 's'}`;
  $('#browser-status').textContent = state.browser.running ? 'Browser open' : 'Not started';
  $('#browser-status').className = `badge${state.browser.running ? ' live' : ''}`;
  $('#session-description').textContent = state.browser.error || (state.browser.running
    ? `${live} of 3 pages cleared for display. Check the previews to confirm the website login.`
    : 'Save the login URL, then sign in once in the Chromium window on this PC.');
  $('#login-button').disabled = busy || !state.config.loginUrl;
  $('#demo-button').hidden = state.config.devices.some(device => device.url);
  $('#service-stats').textContent = `Service up ${Math.floor(state.stats.uptimeSeconds / 60)}m · Server memory ${state.stats.serverMemoryMB} MB (excludes Chromium)`;
  const addresses = state.addresses.length ? state.addresses : [`http://PC-LAN-IP:${location.port}`];
  if (JSON.stringify([...$('#lan-address').options].map(option => option.value)) !== JSON.stringify(addresses)) {
    const previous = $('#lan-address').value;
    $('#lan-address').replaceChildren(...addresses.map(address => new Option(address, address)));
    if (addresses.includes(previous)) $('#lan-address').value = previous;
  }
  for (const device of state.config.devices) {
    const runtime = state.devices.find(item => item.id === device.id);
    const card = cards.get(device.id);
    $('.display-name', card).textContent = device.name;
    const labels = { stopped: 'Stopped', starting: 'Connecting', 'awaiting-approval': 'Review page', streaming: 'Live', error: 'Needs attention' };
    $('.display-state', card).textContent = labels[runtime.state] || runtime.state;
    $('.display-state', card).className = `badge display-state ${runtime.state === 'streaming' ? 'live' : runtime.state === 'awaiting-approval' ? 'review' : runtime.state === 'error' ? 'error' : ''}`;
    $('.receiver-text', card).textContent = runtime.cast.state === 'casting' ? 'Cast session active' : runtime.connected ? 'TV receiver connected' : 'Waiting for TV';
    $('.status-dot', card).className = `status-dot${runtime.connected || runtime.cast.state === 'casting' ? ' connected' : ''}`;
    const destination = $('.cast-destination', card);
    const targets = runtime.cast.sinks;
    const signature = JSON.stringify([targets, runtime.cast.state, device.castSink, state.config.devices.map(value => value.castSink)]);
    if (destination.dataset.signature !== signature) {
      destination.dataset.signature = signature;
      const emptyLabels = {
        idle: 'Select Discover TVs first',
        discovering: 'Searching for TVs…',
        'no-devices': 'No Google Cast TVs found',
        error: 'Discovery needs attention — see below',
      };
      const choices = [new Option(targets.length ? 'Choose a TV…' : emptyLabels[runtime.cast.state] || 'No Google Cast TVs found', '')];
      for (const sink of targets) {
        const assignedElsewhere = state.config.devices.find(value => value.id !== device.id && value.castSink && (value.castSink.id === sink.id || value.castSink.name === sink.name));
        const option = new Option(`${sink.name}${assignedElsewhere ? ` · assigned to TV ${assignedElsewhere.id}` : sink.busy ? ' · in use' : ''}`, sink.id);
        option.disabled = Boolean(assignedElsewhere);
        choices.push(option);
      }
      if (device.castSink && !targets.some(sink => sink.id === device.castSink.id)) choices.push(new Option(`${device.castSink.name} · not discovered`, device.castSink.id));
      destination.replaceChildren(...choices);
      destination.value = device.castSink?.id || '';
    }
    destination.disabled = busy || (!targets.length && !device.castSink);
    $('.cast-message', card).textContent = runtime.cast.message || 'Select Discover TVs to find Google Cast devices.';
    $('.cast-message', card).classList.toggle('cast-error', ['error', 'no-devices'].includes(runtime.cast.state));
    $('[data-action="cast-start"]', card).disabled = busy || !device.castSink || !runtime.frameAvailable || ['casting', 'connecting', 'discovering'].includes(runtime.cast.state);
    $('[data-action="cast-stop"]', card).disabled = busy || runtime.cast.state === 'idle';
    $('.resolution-label', card).textContent = device.resolution;
    $('.display-message', card).textContent = runtime.message || (runtime.state === 'streaming'
      ? (runtime.verification === 'selector' ? 'Protected-page check passed. Streaming to this TV.' : 'Page approved by operator. Streaming to this TV.')
      : 'Save the queue URL, then start this display.');
    $('.approve-button', card).hidden = runtime.state !== 'awaiting-approval' || Boolean(device.readySelector);
    $('[data-action="start"]', card).disabled = busy || !device.url || ['starting', 'streaming', 'awaiting-approval'].includes(runtime.state);
    $('[data-action="stop"]', card).disabled = busy || !device.enabled;
    $('[data-action="refresh"]', card).disabled = busy || !device.enabled || runtime.state === 'starting';
    $('[data-action="approve"]', card).disabled = busy || !runtime.previewAvailable;
    $('[data-action="preview"]', card).disabled = busy || !runtime.previewAvailable;
    $('.last-seen', card).textContent = runtime.lastSeen ? `Last seen ${new Date(runtime.lastSeen).toLocaleTimeString()}` : 'Never connected';
    if (!runtime.previewAvailable) setPreview(device.id, null);
  }
  syncAddresses();
  if (!hydrated) { populate(); hydrated = true; }
}

for (const id of ['1', '2', '3']) {
  const card = $('#display-template').content.firstElementChild.cloneNode(true);
  card.dataset.id = id;
  $('.display-number', card).textContent = `TV ${id}`;
  cards.set(id, card);
  $('#display-grid').append(card);
  card.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'copy') {
      navigator.clipboard.writeText(receiverUrl(id)).then(() => toast('Receiver address copied.'), () => toast(`TV address: ${receiverUrl(id)}`));
    } else if (action === 'preview') {
      activePreview = id;
      $('#preview-title').textContent = `${$('.display-name', card).textContent} · PC preview`;
      $('#large-preview').src = previews.get(id);
      $('#large-preview').hidden = false;
      $('#preview-dialog').showModal();
    } else {
      const messages = { start: 'Display started. Check its preview.', stop: 'Display stopped.', refresh: 'Queue page refreshed. Review may be required.', approve: 'Page approved. The TV will update shortly.', reconnect: 'Reconnect requested. The TV will reload when reachable.', 'cast-start': 'Cast requested. Check the Cast status and TV screen.', 'cast-stop': 'Cast stopped.' };
      perform(() => api(`devices/${id}/${action}`, {}), messages[action]);
    }
  });
  $('.cast-destination', card).addEventListener('change', event => {
    const sinkId = event.target.value;
    perform(() => api(`devices/${id}/cast-assign`, { sinkId }), sinkId ? 'TV assigned to this queue.' : 'TV assignment cleared.').finally(() => {
      $('.cast-destination', card).dataset.signature = '';
      if (state) render();
    });
  });
  $('.device-form', card).addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    data.refreshSeconds = Number(data.refreshSeconds);
    perform(() => api(`devices/${id}/configure`, data), 'Display settings saved.');
  });
}

$('#settings-form').addEventListener('submit', event => {
  event.preventDefault();
  perform(() => api('settings', { loginUrl: $('#login-url').value, fps: Number($('#fps').value), quality: Number($('#quality').value) }), 'Session settings saved.');
});
$('#login-button').addEventListener('click', () => perform(() => api('browser/login', {}), 'Complete login in the Chromium window on this PC.'));
$('#demo-button').addEventListener('click', () => perform(async () => { await api('demo', {}); hydrated = false; }, 'Demo configured. Open the login browser and click “Sign in to demo”.'));
$('#discover-tvs').addEventListener('click', () => perform(() => api('cast/discover', {}), 'Discovery started. Allow a few seconds for TV names to appear.'));
$('#cast-all').addEventListener('click', () => perform(() => api('cast/start', {}), 'Cast requested for all three TVs. Check each Cast status.'));
$('#stop-casts').addEventListener('click', () => perform(() => api('cast/stop', {}), 'All Cast sessions stopped.'));
$('#lan-address').addEventListener('change', syncAddresses);
$('#close-preview').addEventListener('click', () => $('#preview-dialog').close());
$('#preview-dialog').addEventListener('close', () => { activePreview = null; });

async function poll() {
  try {
    if (!busy) {
      state = await api('state');
      render();
      $('#connection-error').hidden = true;
      await Promise.all(state.devices.filter(device => device.previewAvailable).map(async device => {
        try {
          const response = await fetch(`/api/admin/devices/${device.id}/preview.jpg`, { headers: { 'X-Admin-Token': token }, signal: AbortSignal.timeout(5000) });
          if (response.ok) setPreview(device.id, URL.createObjectURL(await response.blob()));
          else setPreview(device.id, null);
        } catch { setPreview(device.id, null); }
      }));
    }
  } catch {
    $('#connection-error').hidden = false;
    for (const id of cards.keys()) setPreview(id, null);
  } finally { setTimeout(poll, 2000); }
}
poll();
