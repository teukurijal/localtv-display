const $ = (selector, parent = document) => parent.querySelector(selector);
const cards = new Map();
const previews = new Map();
let token = '';
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

async function api(route, body) {
  const response = await fetch(`/api/admin/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Admin-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(40000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed.');
  return result;
}

async function perform(action, message) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    await action();
    state = await api('state');
    render();
    if (message) toast(message);
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
  $('#connected-count').textContent = `${state.devices.filter(device => device.connected).length} of 3 TVs connected`;
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
    $('.receiver-text', card).textContent = runtime.connected ? 'TV receiver connected' : 'Waiting for TV';
    $('.status-dot', card).className = `status-dot${runtime.connected ? ' connected' : ''}`;
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
      const messages = { start: 'Display started. Check its preview.', stop: 'Display stopped.', refresh: 'Queue page refreshed. Review may be required.', approve: 'Page approved. The TV will update shortly.', reconnect: 'Reconnect requested. The TV will reload when reachable.' };
      perform(() => api(`devices/${id}/${action}`, {}), messages[action]);
    }
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
$('#lan-address').addEventListener('change', syncAddresses);
$('#close-preview').addEventListener('click', () => $('#preview-dialog').close());
$('#preview-dialog').addEventListener('close', () => { activePreview = null; });

async function poll() {
  try {
    if (!busy) {
      if (!token) {
        const response = await fetch('/api/admin/session', { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('Admin unavailable');
        token = (await response.json()).token;
      }
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
    token = '';
    $('#connection-error').hidden = false;
    for (const id of cards.keys()) setPreview(id, null);
  } finally { setTimeout(poll, 2000); }
}
poll();
