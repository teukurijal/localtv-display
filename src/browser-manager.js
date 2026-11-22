import path from 'node:path';
import { chromium } from 'playwright';
import { InputError, RESOLUTIONS, httpUrl } from './config.js';

function runtime(id) {
  return { id, page: null, state: 'stopped', message: '', epoch: 0, approvedEpoch: -1, frame: null, preview: null, capturedAt: 0, timer: null, retryTimer: null, nextRefresh: 0 };
}

export class BrowserManager {
  constructor(store, options = {}) {
    this.store = store;
    this.options = options;
    this.context = null;
    this.launching = null;
    this.loginPage = null;
    this.closing = false;
    this.recoveryTimer = null;
    this.lastError = '';
    this.displays = new Map(['1', '2', '3'].map(id => [id, runtime(id)]));
  }

  async ensureBrowser() {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.closing = false;
    this.launching = (async () => {
      try {
        const context = await chromium.launchPersistentContext(path.join(this.store.directory, 'chromium-profile'), {
          headless: this.options.headless ?? false,
          viewport: RESOLUTIONS['1080p'],
          ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
          acceptDownloads: false,
          args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
        });
        this.context = context;
        this.lastError = '';
        context.setDefaultTimeout(5000);
        context.on('page', page => {
          page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
        });
        context.on('close', () => {
          if (this.context !== context) return;
          this.context = null;
          this.loginPage = null;
          for (const item of this.displays.values()) {
            clearTimeout(item.timer);
            clearTimeout(item.retryTimer);
            item.page = null;
            this.invalidate(item);
            item.state = this.closing ? 'stopped' : 'error';
            item.message = this.closing ? '' : 'Browser closed. Reconnecting…';
          }
          if (!this.closing && this.store.value.devices.some(device => device.enabled)) {
            this.scheduleRecovery();
          }
        });
        return context;
      } catch {
        this.lastError = 'Chromium could not start. Run npm run install:browser, close any other Queue TV Manager instance, then retry.';
        throw new InputError(this.lastError, 503);
      } finally {
        this.launching = null;
      }
    })();
    return this.launching;
  }

  scheduleRecovery() {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => this.restore().catch(() => this.scheduleRecovery()), 5000);
    this.recoveryTimer.unref();
  }

  async restore() {
    for (const device of this.store.value.devices) {
      if (this.closing) return;
      if (device.enabled && device.url) await this.start(device.id);
    }
  }

  async openLogin() {
    const url = httpUrl(this.store.value.loginUrl, { empty: false });
    const context = await this.ensureBrowser();
    if (!this.loginPage || this.loginPage.isClosed()) this.loginPage = await context.newPage();
    try {
      await this.loginPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.loginPage.bringToFront();
    } catch {
      throw new InputError('The login page did not finish loading. Check the URL and connection, or use the open Chromium window.', 502);
    }
  }

  withhold(item) {
    item.frame = null;
    item.approvedEpoch = -1;
    this.options.onUnavailable?.(item.id);
  }

  invalidate(item) {
    item.epoch += 1;
    this.withhold(item);
    item.preview = null;
    item.capturedAt = 0;
  }

  async stop(id) {
    const item = this.displays.get(id);
    clearTimeout(item.timer);
    clearTimeout(item.retryTimer);
    const page = item.page;
    item.page = null;
    this.invalidate(item);
    item.state = 'stopped';
    item.message = '';
    if (page && !page.isClosed()) await page.close().catch(() => {});
  }

  async start(id) {
    const device = this.store.device(id);
    httpUrl(device.url, { empty: false });
    await this.stop(id);
    const item = this.displays.get(id);
    item.state = 'starting';
    let page;
    try {
      const context = await this.ensureBrowser();
      page = await context.newPage();
      item.page = page;
      this.options.onPage?.(id, page);
      await page.setViewportSize(RESOLUTIONS[device.resolution]);
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame() && item.page === page) {
          this.invalidate(item);
          item.state = 'awaiting-approval';
          item.message = 'Page changed. Check the preview before showing it on the TV.';
        }
      });
      page.on('close', () => this.pageFailed(id, page));
      page.on('crash', () => this.pageFailed(id, page));
      // Queue pages are displays. Keep login popups in the dedicated login tab.
      page.on('popup', popup => popup.close().catch(() => {}));
      const response = await page.goto(device.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (response && response.status() >= 400) throw new Error('Queue page returned an error');
      item.nextRefresh = Date.now() + device.refreshSeconds * 1000;
      await this.capture(id, page);
    } catch {
      if (!page || item.page === page) {
        item.state = 'error';
        this.withhold(item);
        item.message = this.lastError || 'Queue page could not load. Check the URL and network, then start again.';
        // Start is retried after transient failures while this display remains enabled.
        this.retryPage(id);
      }
      throw new InputError(item.message || 'Unable to start the display.', 502);
    }
  }

  pageFailed(id, page) {
    const item = this.displays.get(id);
    if (item.page !== page) return;
    clearTimeout(item.timer);
    this.invalidate(item);
    item.state = 'error';
    item.message = 'Queue tab closed. Reconnecting…';
    this.retryPage(id);
  }

  retryPage(id) {
    const item = this.displays.get(id);
    clearTimeout(item.retryTimer);
    if (this.closing || !this.store.device(id).enabled) return;
    item.retryTimer = setTimeout(() => {
      if (!this.closing && this.store.device(id).enabled) this.start(id).catch(() => {});
    }, 5000);
    item.retryTimer.unref();
  }

  async checkPage(page, device) {
    if (await page.locator('input[type="password"]:visible').count()) return false;
    if (device.readySelector) return page.locator(device.readySelector).first().isVisible();
    return true;
  }

  async capture(id, page) {
    const item = this.displays.get(id);
    if (item.page !== page || page.isClosed()) return;
    const device = this.store.device(id);
    const epoch = item.epoch;
    try {
      const ready = await this.checkPage(page, device);
      if (!ready) this.withhold(item);
      const jpeg = await page.screenshot({ type: 'jpeg', quality: this.store.value.quality, timeout: 5000, caret: 'hide' });
      // Never publish a capture that raced with navigation, stop, or a configuration change.
      if (item.page !== page || item.epoch !== epoch) return;
      item.preview = jpeg;
      const stillReady = ready && await this.checkPage(page, device);
      if (item.page !== page || item.epoch !== epoch) return;
      if (device.readySelector && stillReady) item.approvedEpoch = epoch;
      if (stillReady && item.approvedEpoch === epoch) {
        item.frame = jpeg;
        item.capturedAt = Date.now();
        item.state = 'streaming';
        item.message = '';
      } else {
        this.withhold(item);
        item.state = 'awaiting-approval';
        item.message = !stillReady ? 'Protected page is not ready. Check the PC login and ready selector.' : 'Check the preview, then approve this page for the TV.';
      }
      if (device.refreshSeconds && Date.now() >= item.nextRefresh) {
        item.nextRefresh = Date.now() + device.refreshSeconds * 1000;
        this.invalidate(item);
        await page.goto(device.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
    } catch {
      if (item.page === page) {
        this.withhold(item);
        item.preview = null;
        item.state = 'error';
        item.message = 'Capture unavailable. Check the page and ready selector; capture will retry automatically.';
      }
    } finally {
      if (item.page === page && !page.isClosed()) {
        item.timer = setTimeout(() => this.capture(id, page), Math.round(1000 / this.store.value.fps));
        item.timer.unref();
      }
    }
  }

  async approve(id) {
    const item = this.displays.get(id);
    const device = this.store.device(id);
    if (!item.page || !item.preview) throw new InputError('Wait for a preview before approving this display.', 409);
    const epoch = item.epoch;
    if (!await this.checkPage(item.page, device)) throw new InputError('This page is not ready. Complete the PC login or check the ready selector.', 409);
    if (item.epoch !== epoch) throw new InputError('The page changed. Review the new preview.', 409);
    item.approvedEpoch = epoch;
  }

  async refresh(id) {
    const item = this.displays.get(id);
    if (!item.page || item.page.isClosed()) throw new InputError('Start this display first.', 409);
    this.invalidate(item);
    item.state = 'starting';
    try {
      // A login redirect may have changed page.url(); return to the assigned queue.
      await item.page.goto(this.store.device(id).url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch { throw new InputError('Refresh did not finish. Capture will retry; check the network.', 502); }
  }

  snapshot(id) {
    const item = this.displays.get(id);
    return {
      state: item.state, message: item.message, previewAvailable: Boolean(item.preview),
      frameAvailable: Boolean(this.frame(id)), capturedAt: item.capturedAt || null,
      frameBytes: item.frame?.length ?? 0,
      verification: this.store.device(id).readySelector ? 'selector' : 'operator',
    };
  }

  frame(id, preview = false) {
    const item = this.displays.get(id);
    if (preview) return item.preview;
    return item.state === 'streaming' && Date.now() - item.capturedAt < 10000 ? item.frame : null;
  }

  async close() {
    this.closing = true;
    clearTimeout(this.recoveryTimer);
    for (const id of this.displays.keys()) await this.stop(id);
    if (this.launching) await this.launching.catch(() => {});
    await this.context?.close().catch(() => {});
    this.context = null;
  }
}
