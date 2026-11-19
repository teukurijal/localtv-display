import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const RESOLUTIONS = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
};

export function defaults() {
  return {
    version: 1, loginUrl: '', fps: 1, quality: 80,
    devices: ['Poli Umum', 'Poli Anak', 'Poli Gigi'].map((name, i) => ({
      id: String(i + 1), name, url: '', readySelector: '', resolution: '1080p', refreshSeconds: 0, enabled: false,
    })),
  };
}

export function httpUrl(value, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > 2048) throw new InputError('Enter a valid HTTP or HTTPS URL.');
  value = value.trim();
  if (!value && empty) return '';
  let url;
  try { url = new URL(value); } catch { throw new InputError('Enter a complete URL, starting with http:// or https://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new InputError('Use HTTP or HTTPS URLs without embedded usernames or passwords.');
  }
  return url.href;
}

function numberIn(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new InputError(`${label} must be between ${min} and ${max}.`);
  return value;
}

export function validateDevice(value, id, enabled = false) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 60) {
    throw new InputError('Display name must contain 1–60 characters.');
  }
  if (!Object.hasOwn(RESOLUTIONS, value.resolution)) throw new InputError('Choose 720p, 1080p or 4k.');
  if (typeof value.readySelector !== 'string' || value.readySelector.length > 500) throw new InputError('Ready selector must be at most 500 characters.');
  const refreshSeconds = numberIn(value.refreshSeconds, 0, 86400, 'Refresh interval');
  if (refreshSeconds > 0 && refreshSeconds < 30) throw new InputError('Automatic refresh must be at least 30 seconds.');
  if (refreshSeconds && !value.readySelector.trim()) throw new InputError('Set a protected-page ready selector before enabling automatic refresh.');
  return {
    id, name: value.name.trim(), url: httpUrl(value.url),
    readySelector: value.readySelector.trim(), resolution: value.resolution, refreshSeconds, enabled,
  };
}

export class ConfigStore {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'config.json'); this.value = defaults(); }

  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.devices) || data.devices.length !== 3) throw new Error('Invalid configuration');
      this.value = {
        version: 1, ...this.settings(data),
        devices: data.devices.map((item, i) => validateDevice(item, String(i + 1), item.enabled === true)),
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Configuration could not be loaded. Restore config.json from a backup before restarting.');
      await this.save(this.value);
    }
    return this.value;
  }

  settings(input) {
    return { loginUrl: httpUrl(input.loginUrl), fps: numberIn(input.fps, 1, 3, 'Frames per second'), quality: numberIn(input.quality, 50, 95, 'JPEG quality') };
  }

  async save(next) {
    // Replacement keeps interrupted writes from corrupting the last valid configuration.
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
    this.value = next;
  }

  device(id) {
    const device = this.value.devices.find(item => item.id === id);
    if (!device) throw new InputError('Unknown display.', 404);
    return device;
  }

  async updateDevice(id, patch) {
    const current = this.device(id);
    const next = validateDevice({ ...current, ...patch }, id, patch.enabled ?? current.enabled);
    await this.save({ ...this.value, devices: this.value.devices.map(item => item.id === id ? next : item) });
    return next;
  }
}
