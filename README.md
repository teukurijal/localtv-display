# Local Queue TV Manager

Run three independent outpatient queue displays from one Windows PC. Sign in to the queue website in a dedicated Chromium window; each AQUA TV opens a local receiver URL and renders its assigned website through the PC gateway, or receives a video stream.

This is a working LAN prototype. The real queue-site session policy, AQUA Browser-App compatibility, Windows startup/firewall behavior, and a full clinic-day soak test still need to be checked on the target equipment.

## Windows quick start

1. Copy this project to a stable local folder, for example `C:\QueueTVManager`. Keep `src`, `public`, `scripts`, `package.json`, and `package-lock.json` together. Do not copy Linux `node_modules` to Windows.
2. Install Node.js **22 or newer**. Open a new terminal after installation.
3. Double-click `scripts\setup-windows.cmd`. This installs the locked dependencies and Playwright Chromium. Internet access is needed for setup.
4. Double-click `scripts\start-windows.cmd`. Keep its window open.
5. On the PC, open **http://localhost:8443**.

Equivalent terminal commands, from the project folder:

```powershell
npm ci
npm run install:browser
npm start
```

The default listener is `0.0.0.0:8443`. The admin interface and control API require a loopback connection, a matching loopback Host, and a per-process admin token. A TV or another LAN device cannot use the admin API. Other users/processes with access to this Windows session can administer it; use a dedicated Windows account if needed.

## Try the complete demo

The built-in demo has three different queue pages and one shared login. It uses no credentials or patient data.

1. Click **Try the local demo** while all display URLs are empty.
2. Click **Open login browser**.
3. In the separate Chromium window, click **Sign in to demo**.
4. Click **Start display** on each TV card.
5. Open `http://PC-LAN-IP:8443/tv/1`, `/tv/2`, and `/tv/3` on the TVs.

The demo has a protected-page marker, so it approves only authenticated queue pages automatically. The live clock makes it easy to check whether frames are updating. To switch to the real site, save the real login URL and replace each display URL and ready selector.

## PC gateway / direct website display

Choose **Display settings → Display method → PC gateway · direct website**, then save. Keep the PC display running, logged in, and approved. Open the usual `/tv/1`, `/tv/2`, or `/tv/3` receiver address. It redirects to a separate local origin for that TV, where the TV renders HTML/CSS/JavaScript and plays media itself. Animations and videos are no longer limited by screen-capture frame rate; compatibility and performance still depend on the TV browser. Existing `direct` settings use the gateway automatically. Legacy Trustmedis pharmacy configurations without a saved method also select it; explicitly saved streaming settings are preserved.

The PC gateway has two paths:

- **Page and queue data:** the approved HTML document and latest data responses are relayed from the PC page. Source polling runs once on the PC; TV GET/POST data requests consume these responses without replaying queue-consumption operations upstream.
- **Assets and media:** observed same-origin scripts, stylesheets, images, fonts, and audio/video resources are fetched through the gateway using the PC browser's current cookies and observed authorization headers. Binary media streams with backpressure instead of being buffered or re-encoded. Single byte ranges, suffix ranges, and HEAD requests support native playback and seeking, including files larger than 8 MiB. Response cookie changes are applied to the PC browser only.

The TV receives neither session cookies nor authentication headers. Its own Cookie/Authorization headers cannot replace the PC session. The PC preview and approval monitor still use screenshots, but screenshots are not sent to the direct receiver. Website audio can play on the TV subject to its codec and autoplay policies; a click or remote interaction may be required.

Only same-origin resources actually observed for that display can be served. Other query values and POST bodies must match; numeric jQuery/ExtJS cache-busters (`_`, `_dc`) are ignored. Absolute upstream URLs in HTML/CSS/JS are rewritten to the separate local origin. Public third-party assets are loaded directly by the TV. Observed same-origin asset redirect chains resolve to their known final destination; a new upstream redirect holds the display until the source is refreshed. Redirects never forward the session to an unobserved host. Upstream framing policies are preserved; the shell and page share a dedicated origin, separate from the admin origin.

With `yarn dev --port 3001`, direct TV 1 uses **3002**, TV 2 uses **3003**, and TV 3 uses **3004**. Each port opens only when that mode is selected or its receiver is opened. Allow the required TCP ports on the trusted LAN. Occupied ports are reported instead of silently choosing a different address. Start below port 65533 to leave room for all three displays. Keep using the receiver link from the admin card; you do not have to enter the additional port manually.

Stop, navigation, lost approval, session-check failure, or loss of the PC connection blanks the direct receiver. Stop, approval loss and mode changes cancel active gateway transfers; closing a TV request also releases its upstream connection. Navigation clears the old resource allowlist and cached data. An observed HTTP 401/403, password form, or gateway asset returning HTML holds the display until the operator signs in on the PC and refreshes the source page. **Reconnect** reloads the display. Switching back to streaming sends existing direct receivers back to the streaming page. An individual streaming receiver can also be opened with `/tv/1?mode=stream` while testing the gateway.

This gateway supports approved display traffic rather than arbitrary browsing. WebSockets, browser-local authentication state, authenticated third-party origins, unobserved adaptive-media segments, and requests whose parameters depend on TV-local state still need a site-specific adapter. Partitioned response cookies are not imported into the PC's ordinary cookie jar. Main documents/data are bounded to 8 MiB per response and 64 MiB per display; rewritten text assets are bounded to 8 MiB. Binary transfers have no fixed file-size limit, with at most 16 active requests per display and a 30-second inactivity timeout. The admin card reports active transfers, observed assets, and missing request paths without exposing query tokens or request bodies. Authenticated Trustmedis compatibility must still be checked on the real session and TV model.

## Smooth video streaming

TV receivers now try WebRTC video automatically. Open the same receiver URL, such as `http://PC-LAN-IP:3001/tv/1` when running `yarn dev --port 3001`. The PC keeps the website login; the TV needs only a browser and the receiver URL, not Miracast or Chromecast.

The receiver shows **Live video** once playback starts. **Use compatibility mode** switches to JPEG frames; **Try video** switches back. You can also bookmark `/tv/1?mode=jpeg` to always use JPEG. Unsupported browsers or failed video connections fall back automatically, with video retries after 30 seconds. The PC and TV must be able to communicate directly on the LAN; client isolation or a firewall blocking Chromium's WebRTC traffic can prevent video even when HTTP works.

Video targets 1280 × 720 at up to 30 fps, with a 4 Mbps encoding limit per viewer. Actual frame rate depends on page animation, PC capacity and the TV decoder. Test all three displays on the actual equipment. Up to two video viewers per display are allowed; additional viewers can use compatibility mode. The admin's frame-rate and quality settings control JPEG captures/previews, not video's target rate.

Video is currently silent. Each display is captured automatically through Chromium's screencast interface, so there is no screen-picker step. A separate Chromium encoder receives only approved images and creates the WebRTC stream; it has no queue-site cookies. Navigation, Stop, lost approval, a missing protected-page marker, and capture failures close the corresponding video stream. The existing limitations of manual approval still apply: use a reliable protected-page ready selector to detect in-page login/session changes.

Connections use local ICE candidates with no external STUN/TURN service. TVs whose browsers/codecs cannot play WebRTC retain the JPEG option. Closing a receiver releases its connection; abandoned sessions expire after 15 seconds without status polling.

## Use the real queue website

1. Save the website **login URL** in the PC admin panel.
2. Click **Open login browser** and sign in manually in that dedicated Chromium window. This is separate from your regular Chrome profile.
3. In each card’s **Display settings**, save its poli name, queue URL, and resolution. Start with 720p; the JPEG fallback defaults to 1 frame/second and 80% quality.
4. Start each display. Enlarge the private PC preview and confirm the correct, authenticated poli page appears.
5. Without a ready selector, click **Approve page for TV**. Approval is reset when the main page navigates, is refreshed, is restarted, or capture fails. A visible password field cannot be approved.
6. Open the card’s receiver address in the corresponding TV browser. Pick the actual Wi-Fi IPv4 address from the PC network selector; systems with VPN/WSL adapters may list several addresses.

The app cannot infer arbitrary websites’ authentication state. “Browser open” means Chromium is running. “Approved by operator” means the operator reviewed the page; it is not an automatic login guarantee. For reliable automatic recovery, configure a ready selector after inspecting the real website.

### Protected-page ready selector

An optional CSS selector, for example `#queue-board[data-authenticated="true"]`, must match an element visible **only on a valid authenticated queue board**. Do not use a generic `body`, shared header, or element also present on the login page.

The service checks it before and after each capture. A missing marker or visible password input stops broadcasting. Its reappearance allows automatic streaming. An optional refresh interval of at least 30 seconds is available only with a selector. Leave automatic refresh at `0` if the site already updates itself.

Without a reliable marker, use manual approval. A site that changes to a login screen inside the same page without navigation or a password field may need an additional site-specific check. Validate the marker against login, logout, session expiry, and error screens before operational use.

### Controls

- **Start / Stop:** operates on one browser page; Stop clears the image and pauses the receiver.
- **Refresh:** reloads that queue page. Other streams stay active. Manual approval is required again when no selector is configured.
- **Reconnect:** asks the assigned receiver to reload on its next successful poll. It cannot launch a closed TV browser or turn on a TV.
- **Preview:** private to the PC; useful before approval and for diagnosing login problems.
- **Last seen:** the last receiver status request. A receiver is considered disconnected after 12 seconds without a request. It indicates browser reachability, not whether a human is watching the physical TV.

## LAN and Windows setup

All TVs and the PC must be on the same LAN, and Wi-Fi client/AP isolation must be disabled. Reserve the PC’s IPv4 address in the router. Use the PC’s LAN IP on the TVs, never `localhost`.

On the trusted clinic network, allow inbound TCP port 8443 on the **Private** profile and local subnet only. Run this manually from an elevated PowerShell window if needed:

```powershell
New-NetFirewallRule -DisplayName "Queue TV Manager (Private LAN)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8443 -Profile Private -RemoteAddress LocalSubnet
```

The project does not change firewall or router settings automatically. Do not port-forward the service. Display frames are unencrypted HTTP on the trusted LAN and are visible to devices that can reach the receiver URLs. Only display information approved for that audience.

### Start at Windows sign-in

After moving the project to its permanent folder and completing setup, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1
```

This creates a shortcut in the **current user’s Startup folder**. It runs after that user signs in, with an interactive desktop available for Chromium. It does not install a Windows service or start before sign-in. Start only one instance. Remove the shortcut with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1 -Remove
```

Enabled displays are remembered. On restart, the browser profile is reused. A valid ready selector lets a display recover automatically; otherwise it waits for the operator to inspect and approve it. If the website session expires, sign in on the PC again. Browser or individual tab closure triggers a retry while displays remain enabled.

### TV screen behavior

The receiver fills the browser viewport with a proportionally scaled image and no scrollbars. **Enter fullscreen** requires a click or TV-remote action because browsers generally restrict automatic fullscreen. Fullscreen availability depends on Browser-App. Hide browser chrome through its kiosk/fullscreen settings if available.

A screen wake-lock request is best effort and commonly unavailable over plain HTTP. Disable TV screen sleep/screensavers through TV settings. Keep the Windows PC awake during operating hours. After a TV restart, reopen or bookmark its assigned receiver URL.

## Storage and configuration

- Windows: `%LOCALAPPDATA%\QueueTVManager\`
- Linux: `~/.local/share/queue-tv-manager/`
- Override: `QUEUE_DATA_DIR` environment variable.

The directory contains `config.json` and `chromium-profile/`. URLs, display settings, and enabled states are persisted with atomic file replacement. The dedicated Chromium profile retains cookies/storage subject to the website’s policy. Treat this folder as private: browser session data can grant access to the queue website. Passwords are never requested by this app. Captures stay in memory; they are not written to logs or disk by the running service.

Optional environment settings:

To use a different port for development, run `yarn dev --port 3200` (or `npm run dev -- --port 3200`). The `--port` option also works with `start` and takes precedence over `PORT`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8443` | HTTP server and receiver port |
| `HOST` | `0.0.0.0` | Listener address; use `127.0.0.1` for PC-only development |
| `QUEUE_DATA_DIR` | Platform-specific folder above | Configuration and dedicated Chromium profile |

Changing the port or PC IP also changes the TV receiver addresses. The built-in demo URLs must be updated if the port changes.

## Implementation

Node.js provides the HTTP backend and static admin/receiver UI. Playwright controls a persistent Chromium context; tough-cookie validates response cookies before applying them to that browser's session. Each poli uses a separate page. Shared cookies/storage provide one login when the website supports it. The PC gateway relays approved page/data responses and streams observed assets/media through authenticated requests. Screenshots are captured without overlapping work within a page and held in memory. Receivers poll status independently, with timeouts, bounded retry delays, and a blank/offline state on failures. Screen streaming uses Chromium screencast frames and an isolated canvas/WebRTC encoder; JPEG fallback polls approved screenshots.

Receivers follow the selected gateway or streaming mode. Streaming prefers WebRTC, with HTTP JPEG polling as a compatibility fallback. No build pipeline, database, or cloud service is required. The UI is plain HTML/CSS/JavaScript; the TV shell uses ES5 syntax and XMLHttpRequest for older TV browsers, while the proxied website retains its own browser requirements. Screen streaming does **not transmit audio**. Gateway mode lets the website play audio on the TV; its autoplay behavior and announcement timing must be checked with the real site.

Capturing three 4K pages costs more CPU and bandwidth than 1080p. Start at 1 fps and measure on the real PC. The dashboard reports Node server memory only; use Windows Task Manager for Chromium CPU/RAM and total network usage. A frame is withheld if its capture is over 10 seconds old; this does not detect a queue website that itself stops updating.

Playwright references: [persistent browser context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), [page screenshots](https://playwright.dev/docs/screenshots).

## Validation

```powershell
npm run check
npm test
npm run test:browser
npm run test:video
npm run test:direct
```

The direct integration tests verify authenticated HTML/assets, native animation and WebM playback, live queue data, per-display separation, cookie isolation/rotation, files above 8 MiB, byte-range seeking, blocked unobserved requests and redirects, non-replayed POSTs, transfer cancellation, expired sessions, and network recovery.

The video integration test exercises real WebRTC playback, independent animated sources, approval revocation, and JPEG fallback in headless Chromium. It does not certify any physical TV model.

The browser integration test uses temporary data and headless Chromium. It exercises a single shared login, three different streams, LAN admin isolation, selector/manual approval, per-TV refresh/stop, receiver reconnection, service restart with persistent authentication, browser recovery, and desktop/mobile admin layouts. Demo screenshots are written to ignored `test-results/`. It never uses a real account.

## Before clinic deployment

- Confirm all three real poli URLs stay authenticated in the same browser context.
- Validate the ready selector through an expired login and website error state.
- Check all three AQUA TVs for readability, scaling, fullscreen, sleep and automatic reconnect.
- Test the Windows startup shortcut, firewall rule and reserved IP on the actual host.
- Run a full operating-day soak test and record PC CPU, memory, network load and queue freshness.
- Confirm that hospital IT and the website permit the display setup; keep unnecessary patient data out of logs.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| TV cannot reach the PC | Correct LAN IP/port, Private firewall rule, same LAN, no AP isolation, PC awake. Run natively on Windows; WSL networking may need additional routing. |
| Admin returns 403 | Use `http://localhost:8443` on the PC, not the LAN address or another computer. |
| Chromium fails to start | Run `npm run install:browser`; close another manager instance using the same profile. Linux needs a desktop for normal interactive operation. |
| Page waits for review | Complete PC login, check the private preview, then approve; if a selector is configured, ensure it is valid and visible. |
| TV shows an offline state | Check the server, page capture and Wi-Fi. The receiver retries automatically. |
| Session does not survive restart | Check the website’s session policy. A persistent profile cannot extend a server-expired session. |
| Multiple poli tabs log each other out | Confirm the website permits shared-account concurrent pages before adding streaming workarounds. |
| Queue calls have no sound | Screen streaming is video-only. In gateway mode, check the website's audio resources, TV volume, codec support, and autoplay permission. |
| Port already in use | Stop the other instance or choose a different `PORT` and update receiver URLs/firewall. |
