import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { InputError, RESOLUTIONS } from './config.js';

const ids = ['1', '2', '3'];
const isWsl = process.platform === 'linux' && /microsoft/i.test(os.release());
const discoveryHelp = 'No Google Cast TVs found yet. Open the Cast menu in this display’s Chrome sender window and allow local network access if prompted. Check that the TV supports Google Cast and is on the same LAN, then select Discover TVs to retry.';

function entry() {
  return { context: null, page: null, session: null, sinks: [], state: 'idle', message: '', activeSink: null, confirmed: false, timer: null, discoveryTimer: null };
}

// Each output has its own Chrome process/profile. These browsers see only the
// approved receiver frames; website cookies remain in BrowserManager's profile.
export class CastManager {
  constructor(store, manager, getOrigin, options = {}) {
    this.store = store;
    this.manager = manager;
    this.getOrigin = getOrigin;
    this.options = options;
    this.entries = new Map(ids.map(id => [id, entry()]));
    this.operations = new Map();
    this.closing = false;
  }

  serialize(id, action) {
    this.store.device(id);
    const next = (this.operations.get(id) || Promise.resolve()).then(action);
    this.operations.set(id, next.catch(() => {}));
    return next;
  }

  snapshot(id) {
    const item = this.entries.get(id);
    return {
      state: item.state, message: item.message, activeSink: item.activeSink,
      sinks: item.sinks.map(sink => ({ id: sink.id, name: sink.name, busy: Boolean(sink.session) })),
    };
  }

  async command(session, method, parameters = {}) {
    let timer;
    try {
      return await Promise.race([
        session.send(method, parameters),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cast command timed out')), this.options.commandTimeout ?? 12000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  noDevices(item) {
    item.state = 'no-devices';
    item.message = isWsl
      ? 'No Google Cast TVs found yet. This service is running in WSL. Run the app directly on Windows with Google Chrome to discover TVs on the Windows LAN.'
      : discoveryHelp;
  }

  async discoverSinks(id) {
    const item = this.entries.get(id);
    // An active sender already observes sink updates. Re-enabling discovery
    // must not replace its connection status or interrupt its Cast session.
    if (item.activeSink) return;
    clearTimeout(item.discoveryTimer);
    item.state = item.sinks.length ? 'ready' : 'discovering';
    item.message = item.sinks.length
      ? 'Choose a TV from the list. Discovery continues while this browser is open.'
      : 'Looking for Google Cast TVs on this network…';
    const context = item.context;
    if (!item.sinks.length) {
      item.discoveryTimer = setTimeout(() => {
        if (item.context === context && item.state === 'discovering' && !item.sinks.length) this.noDevices(item);
      }, this.options.discoveryTimeout ?? 10000);
      item.discoveryTimer.unref();
    }
    try {
      // Cast.enable subscribes to asynchronous results; its acknowledgement
      // does not mean that Chrome has found a destination.
      await this.command(item.session, 'Cast.enable');
    } catch {
      clearTimeout(item.discoveryTimer);
      item.state = 'error';
      item.message = 'Chrome opened, but Cast discovery failed. Open its Cast menu and check that casting is enabled, then select Discover TVs to retry.';
      throw new InputError(item.message, 503);
    }
  }

  updateSinks(id, context, sinks) {
    const item = this.entries.get(id);
    if (item.context !== context) return;
    item.sinks = sinks.filter(sink => typeof sink.id === 'string' && typeof sink.name === 'string').map(sink => ({ id: sink.id, name: sink.name, session: sink.session || '' }));
    if (!item.activeSink) {
      if (['discovering', 'ready', 'no-devices'].includes(item.state)) {
        if (item.sinks.length) {
          clearTimeout(item.discoveryTimer);
          item.state = 'ready';
          item.message = 'Choose a TV from the list. Discovery continues while this browser is open.';
        } else if (item.state === 'ready') this.noDevices(item);
      }
      return;
    }
    const sink = item.sinks.find(value => value.id === item.activeSink.id);
    if (sink?.session) {
      clearTimeout(item.timer);
      item.state = 'casting';
      item.confirmed = true;
      item.message = `Cast session active on ${sink.name}.`;
    } else if (item.confirmed) {
      item.state = 'error';
      item.message = 'Cast disconnected. Check the TV and select Cast to reconnect.';
    }
  }

  async ensureSession(id) {
    if (this.closing) throw new InputError('The service is shutting down.', 503);
    const item = this.entries.get(id);
    if (item.context && item.page && !item.page.isClosed()) return item;
    item.state = 'discovering';
    item.message = 'Looking for Google Cast TVs on this network…';
    const profile = path.join(this.store.directory, `cast-profile-${id}`);
    const executablePath = this.options.executablePath || process.env.QUEUE_CAST_EXECUTABLE;
    const headless = this.options.headless === true;
    let context;
    try {
      const launch = this.options.launch || ((directory, options) => chromium.launchPersistentContext(directory, options));
      // Playwright's normal defaults disable MediaRouter. Keep a small explicit
      // argument set, retain Chrome's sandbox, and use a pipe (no debug TCP port).
      context = await launch(profile, {
        ...(executablePath ? { executablePath } : { channel: 'chrome' }),
        headless, ignoreDefaultArgs: true,
        viewport: RESOLUTIONS[this.store.device(id).resolution],
        timeout: 15000, acceptDownloads: false,
        args: [
          `--user-data-dir=${profile}`, '--remote-debugging-pipe',
          '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
          '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
          '--enable-features=MediaRouter', '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
          ...(headless ? ['--headless=new'] : []), 'about:blank',
        ],
      });
      if (this.closing) { await context.close(); throw new Error('Closing'); }
      item.context = context;
      item.page = context.pages()[0] || await context.newPage();
      await item.page.setViewportSize(RESOLUTIONS[this.store.device(id).resolution]);
      item.session = await context.newCDPSession(item.page);
      context.on('close', () => {
        if (item.context !== context) return;
        clearTimeout(item.timer);
        clearTimeout(item.discoveryTimer);
        item.context = null;
        item.page = null;
        item.session = null;
        item.sinks = [];
        item.activeSink = null;
        item.state = 'error';
        item.message = 'Cast browser closed. Discover TVs again to reconnect.';
      });
      item.page.on('close', () => {
        if (item.context === context) context.close().catch(() => {});
      });
      item.page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      item.page.on('popup', popup => popup.close().catch(() => {}));
      item.session.on('Cast.sinksUpdated', ({ sinks }) => this.updateSinks(id, context, sinks));
      item.session.on('Cast.issueUpdated', ({ issueMessage }) => {
        if (item.context !== context || !issueMessage) return;
        clearTimeout(item.timer);
        clearTimeout(item.discoveryTimer);
        item.state = 'error';
        item.message = String(issueMessage).slice(0, 300);
      });
      await item.page.goto(`${this.getOrigin()}/tv/${id}?cast=1`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await this.discoverSinks(id);
      return item;
    } catch (error) {
      clearTimeout(item.discoveryTimer);
      item.context = null;
      item.page = null;
      item.session = null;
      item.sinks = [];
      item.activeSink = null;
      item.state = 'error';
      item.message = error instanceof InputError ? error.message : context
        ? 'Chrome opened, but its receiver page could not be prepared. Check that the service is running and select Discover TVs to retry.'
        : isWsl
          ? 'Could not open Google Chrome inside WSL. Run scripts\\start-windows.cmd with Windows Node.js and Google Chrome installed on Windows.'
          : /not found|executable.*(?:exist|missing)/i.test(error.message)
            ? 'Google Chrome was not found. Install Google Chrome on the computer running this service, or set QUEUE_CAST_EXECUTABLE to its executable, then retry.'
            : 'Could not open Google Chrome for casting. Close other Queue TV Manager instances and make sure a desktop session is available, then retry.';
      await context?.close().catch(() => {});
      throw new InputError(item.message, 503);
    }
  }

  discover(id) {
    return this.serialize(id, async () => {
      const item = this.entries.get(id);
      if (item.context && item.page && !item.page.isClosed()) await this.discoverSinks(id);
      else await this.ensureSession(id);
      return this.snapshot(id);
    });
  }

  resolveSink(id, sinkId) {
    if (typeof sinkId !== 'string') throw new InputError('Choose a discovered TV.');
    const item = this.entries.get(id);
    const sink = item.sinks.find(value => value.id === sinkId);
    if (!sink) throw new InputError('This TV is not currently discovered. Turn it on and select Discover TVs.', 409);
    // The CDP cast command targets names, so duplicate names must never be guessed.
    if (item.sinks.filter(value => value.name === sink.name).length !== 1) throw new InputError('Two TVs have the same Cast name. Give each TV a different name in its settings.', 409);
    for (const device of this.store.value.devices) {
      if (device.id !== id && device.castSink && (device.castSink.id === sink.id || device.castSink.name === sink.name)) {
        throw new InputError(`This TV is already assigned to TV ${device.id}. Choose a different TV.`, 409);
      }
    }
    return sink;
  }

  async waitForSink(id, sinkId) {
    const deadline = Date.now() + (this.options.discoveryTimeout ?? 5000);
    const item = this.entries.get(id);
    while (!item.sinks.some(sink => sink.id === sinkId) && item.context && !this.closing && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return this.resolveSink(id, sinkId);
  }

  assign(id, sinkId) {
    return this.serialize(id, async () => {
      const sink = sinkId ? this.resolveSink(id, sinkId) : null;
      if (this.entries.get(id).activeSink) await this.stopSession(id);
      await this.store.updateDevice(id, { castSink: sink ? { id: sink.id, name: sink.name } : null });
    });
  }

  start(id) {
    return this.serialize(id, async () => {
      const assigned = this.store.device(id).castSink;
      if (!assigned) throw new InputError('Discover TVs and assign a different TV to this display first.', 409);
      if (!this.manager.frame(id)) throw new InputError('Start this queue display and approve its preview before casting.', 409);
      let item = await this.ensureSession(id);
      let sink = await this.waitForSink(id, assigned.id);
      if (item.state === 'casting' && item.activeSink?.id === sink.id) return;
      if (sink.session && !item.activeSink) throw new InputError('This TV is already casting. Stop its existing cast before using it here.', 409);
      if (item.activeSink) {
        await this.stopSession(id);
        item = await this.ensureSession(id);
        sink = await this.waitForSink(id, assigned.id);
      }
      item.activeSink = { id: sink.id, name: sink.name };
      item.confirmed = false;
      item.state = 'connecting';
      item.message = `Connecting to ${sink.name}…`;
      try {
        await item.page.setViewportSize(RESOLUTIONS[this.store.device(id).resolution]);
        await this.command(item.session, 'Cast.startTabMirroring', { sinkName: sink.name });
        // A successful command alone is not proof of a TV session.
        this.updateSinks(id, item.context, item.sinks);
        if (item.state === 'connecting') {
          item.timer = setTimeout(() => {
            if (item.state === 'connecting') {
              item.state = 'error';
              item.message = 'The TV has not confirmed a Cast session. Check its screen, Wi-Fi, and Cast support, then retry.';
            }
          }, this.options.confirmTimeout ?? 20000);
          item.timer.unref();
        }
      } catch {
        // Close a failed/timed-out sender so a delayed command cannot cast later.
        await this.stopSession(id);
        item.state = 'error';
        item.message = 'Cast could not start. Check that the selected TV supports Google Cast and is reachable, then retry.';
        throw new InputError(item.message, 502);
      }
    });
  }

  async stopSession(id) {
    const item = this.entries.get(id);
    clearTimeout(item.timer);
    clearTimeout(item.discoveryTimer);
    if (item.session && item.activeSink) {
      let timer;
      try {
        await Promise.race([
          item.session.send('Cast.stopCasting', { sinkName: item.activeSink.name }).catch(() => {}),
          new Promise(resolve => { timer = setTimeout(resolve, 2000); timer.unref(); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    const context = item.context;
    item.context = null;
    item.page = null;
    item.session = null;
    item.sinks = [];
    item.activeSink = null;
    item.confirmed = false;
    item.state = 'idle';
    item.message = 'Cast stopped.';
    await context?.close().catch(() => {});
  }

  stop(id) { return this.serialize(id, () => this.stopSession(id)); }

  async all(action) {
    const results = await Promise.allSettled(ids.map(id => this[action](id)));
    return results.map((result, index) => ({ id: ids[index], ok: result.status === 'fulfilled', ...(result.status === 'rejected' ? { error: result.reason instanceof InputError ? result.reason.message : 'The Cast operation failed.' } : {}) }));
  }

  async close() {
    this.closing = true;
    await this.all('stop');
  }
}
