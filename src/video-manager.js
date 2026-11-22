import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import { InputError } from './config.js';
import { installVideoSender } from './video-sender.js';

// CDP supplies changing frames; WebRTC encodes/transports them at up to 30 fps.
// Only approved frames enter the separate encoder browser (never login cookies).
export class VideoManager {
  constructor(manager, getOrigin, options = {}) {
    this.manager = manager;
    this.getOrigin = getOrigin;
    this.options = options;
    this.entries = new Map();
    this.sessions = new Map();
    this.pending = new Set();
    this.browser = null;
    this.launching = null;
    this.closing = false;
    this.sweep = setInterval(() => {
      for (const [key, session] of this.sessions) if (Date.now() - session.seen > 15000) this.release(session.id, key);
    }, 2000);
    this.sweep.unref();
  }

  async ensureBrowser() {
    if (this.closing) throw new Error('Closing');
    if (this.browser) return this.browser;
    if (!this.launching) {
      this.launching = chromium.launch({ headless: true,
        ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
      }).then(async browser => {
        if (this.closing) { await browser.close(); throw new Error('Closing'); }
        this.browser = browser;
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
          for (const id of this.entries.keys()) this.invalidate(id);
        });
        return browser;
      }).finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  active(id, entry) {
    const item = this.manager.displays.get(id);
    return !this.closing && this.entries.get(id) === entry && item.page === entry.source && item.epoch === entry.epoch && Boolean(this.manager.frame(id));
  }

  async create(id, entry) {
    const browser = await this.ensureBrowser();
    if (!this.active(id, entry)) throw new Error('Display changed');
    entry.page = await browser.newPage();
    await entry.page.goto(`${this.getOrigin()}/internal/video`);
    await entry.page.evaluate(installVideoSender);
    if (!this.active(id, entry)) throw new Error('Display changed');
    await entry.page.evaluate(data => window.videoSender.draw(data), this.manager.frame(id).toString('base64'));
    entry.cdp = await entry.source.context().newCDPSession(entry.source);
    entry.cdp.on('Page.screencastFrame', event => {
      this.forward(id, entry, event).catch(() => this.invalidate(id, entry));
    });
    await entry.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
    if (!this.active(id, entry)) throw new Error('Display changed');
    // Refresh static pages and recheck approval even when CDP emits no new frames.
    entry.timer = setInterval(() => {
      if (!this.active(id, entry)) return this.invalidate(id, entry);
      if (!entry.busy && Date.now() - (entry.lastFrame || 0) > 1000) entry.page.evaluate(data => window.videoSender.draw(data), this.manager.frame(id).toString('base64')).catch(() => this.invalidate(id, entry));
    }, 1000);
    entry.timer.unref();
  }

  async forward(id, entry, event) {
    if (entry.busy || !this.active(id, entry)) {
      await entry.cdp?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      return;
    }
    entry.busy = true;
    try {
      const item = this.manager.displays.get(id);
      const ready = await this.manager.checkPage(entry.source, this.manager.store.device(id));
      if (!this.active(id, entry)) return;
      if (!ready) {
        this.manager.withhold(item);
        item.state = 'awaiting-approval';
        item.message = 'Protected page is not ready. Check the PC login and ready selector.';
        return;
      }
      if (!this.active(id, entry)) return;
      await entry.page.evaluate(data => window.videoSender.draw(data), event.data);
      entry.lastFrame = Date.now();
    } finally {
      entry.busy = false;
      await entry.cdp?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    }
  }

  async offer(id, offer) {
    if (!offer || offer.type !== 'offer' || typeof offer.sdp !== 'string' || offer.sdp.length > 12000) throw new InputError('Invalid video offer.');
    if (!this.manager.frame(id)) throw new InputError('Display is not approved or available.', 409);
    if (this.pending.has(id)) throw new InputError('Video is connecting. Retry shortly.', 429);
    if ([...this.sessions.values()].filter(session => session.id === id).length >= 2) throw new InputError('This display already has two video viewers.', 429);
    this.pending.add(id);
    const key = randomBytes(24).toString('hex');
    let entry = this.entries.get(id);
    try {
      if (!entry) {
        const item = this.manager.displays.get(id);
        entry = { source: item.page, epoch: item.epoch, page: null, cdp: null, timer: null, busy: false };
        this.entries.set(id, entry);
        await this.create(id, entry);
      }
      if (!this.active(id, entry)) throw new Error('Display changed');
      this.sessions.set(key, { id, seen: Date.now() });
      const answer = await entry.page.evaluate(args => window.videoSender.answer(args), { id: key, offer });
      if (!this.active(id, entry)) throw new Error('Display changed');
      return { session: key, answer };
    } catch {
      if (this.entries.get(id) !== entry) this.dispose(entry);
      this.release(id, key);
      if (![...this.sessions.values()].some(session => session.id === id)) this.invalidate(id);
      throw new InputError('Video could not connect. JPEG mode remains available.', 503);
    } finally { this.pending.delete(id); }
  }

  touch(id, key) {
    const session = this.sessions.get(key);
    if (!session || session.id !== id) return false;
    session.seen = Date.now();
    return true;
  }

  release(id, key) {
    if (this.sessions.get(key)?.id !== id) return;
    this.sessions.delete(key);
    this.entries.get(id)?.page?.evaluate(key => window.videoSender.close(key), key).catch(() => {});
    if (![...this.sessions.values()].some(session => session.id === id)) this.invalidate(id);
  }

  invalidate(id, expected) {
    const entry = this.entries.get(id);
    if (!entry || (expected && entry !== expected)) return;
    this.entries.delete(id);
    for (const [key, session] of this.sessions) if (session.id === id) this.sessions.delete(key);
    this.dispose(entry);
  }

  dispose(entry) {
    if (!entry) return;
    clearInterval(entry.timer);
    entry.cdp?.detach().catch(() => {});
    entry.page?.close().catch(() => {});
  }

  async close() {
    this.closing = true;
    clearInterval(this.sweep);
    for (const id of this.entries.keys()) this.invalidate(id);
    await this.launching?.catch(() => {});
    await this.browser?.close();
  }
}
