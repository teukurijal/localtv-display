import { EventEmitter } from 'node:events';

export const testSinks = [
  { id: 'aqua-1', name: 'AQUA Umum' },
  { id: 'aqua-2', name: 'AQUA Anak' },
  { id: 'aqua-3', name: 'AQUA Gigi' },
];

export function fakeCastDriver(options = {}) {
  const launches = [];
  const launch = async (profile, launchOptions) => {
    const id = profile.slice(-1);
    if (options.failLaunch === id) throw new Error("Chromium distribution 'chrome' is not found");
    const session = new EventEmitter();
    const page = new EventEmitter();
    const context = new EventEmitter();
    let closed = false;
    let sinks = (options.sinks || testSinks).map(sink => ({ ...sink }));
    const calls = [];
    page.isClosed = () => closed;
    page.setViewportSize = async viewport => { page.viewport = viewport; };
    page.goto = async url => { page.url = url; };
    context.pages = () => [page];
    context.newPage = async () => page;
    context.newCDPSession = async () => session;
    context.close = async () => { if (!closed) { closed = true; context.emit('close'); } };
    session.send = async (method, params) => {
      calls.push({ method, params });
      if (method === 'Cast.enable') {
        if (options.failDiscovery === id) throw new Error('Simulated Cast protocol failure');
        session.emit('Cast.sinksUpdated', { sinks });
      }
      if (method === 'Cast.startTabMirroring') {
        if (options.hangStart === id) return new Promise(() => {});
        if (options.failStart === id) throw new Error('Simulated receiver failure');
        if (options.autoConfirm !== false) {
          sinks = sinks.map(sink => ({ ...sink, session: sink.name === params.sinkName ? 'Casting a tab' : '' }));
          session.emit('Cast.sinksUpdated', { sinks });
        }
      }
      if (method === 'Cast.stopCasting') {
        sinks = sinks.map(sink => ({ ...sink, session: '' }));
        session.emit('Cast.sinksUpdated', { sinks });
      }
    };
    launches.push({ id, profile, options: launchOptions, session, page, context, calls });
    return context;
  };
  return { launch, launches };
}
