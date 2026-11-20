# Local Queue TV Manager

Run three independent outpatient queue displays from one Windows PC. Sign in to the queue website in a dedicated Chromium window, then assign and cast each approved queue page to a different Google Cast TV. TVs without Google Cast can use the browser receiver URLs.

This is a working LAN prototype. The real queue-site session policy, AQUA Browser-App compatibility, Windows startup/firewall behavior, and a full clinic-day soak test still need to be checked on the target equipment.

The Cast controls are experimental until tested on your three physical TVs. Automated tests validate independent sender processes, target assignment, PC controls, and the real Chrome Cast discovery protocol; they do not establish that your AQUA model supports casting or that three wireless streams remain stable throughout a clinic day.

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

## Control three Cast TVs from one PC

Install **Google Chrome** on the Windows PC. Each TV must support **Google Cast / Chromecast**, and all devices must be on the same LAN. Miracast-only receivers do not work with this integration. Verify that all TVs appear in Chrome’s normal Cast menu and give each a unique name in its settings.

1. Sign in to the queue website on the PC, configure the three poli URLs, and start each display.
2. Confirm each preview and approve it, or configure a valid protected-page ready selector. Casting is blocked until that display has an approved frame.
3. Click **Discover TVs** in Queue TV Manager. It opens three dedicated Chrome sender windows. The destination lists show **Searching for TVs…** while waiting for results. After 10 seconds with no results, they show **No Google Cast TVs found** with recovery steps; any TVs found later still appear automatically.
4. Under each display’s **Cast destination**, select a different TV. Assignments are saved. Duplicate destinations and ambiguous duplicate TV names are rejected.
5. Click **Cast all three**, or **Cast to TV** on an individual card. The app requests tab mirroring to each selected TV; you do not type a receiver URL on the TV.
6. Check the three physical screens. Each should show its own poli. Use **Stop cast** for one TV or **Stop all casts** for all three. Refreshing or stopping a queue does not change the other queues.

The sender windows render only local approved receiver frames. They do not contain your queue-site login or website cookies. The authenticated pages still share one Chromium profile. Each sender uses a separate Chrome process/profile, so it has its own Cast session and content. Keep these windows open and leave their receiver tabs unchanged while casting.

**Start display / Stop** controls queue capture. Stopping capture shows a paused screen on any active cast. **Cast to TV / Stop cast** controls the connection to the physical TV. Stopping one cast does not stop capture or other TV sessions.

“Cast requested” means a command was sent. “Cast session active” appears only after Chrome reports an active session for that destination; check the physical TV to confirm readability and the correct content. Discovery or a local sender tab alone never counts as a connected TV. Failed destinations are reported individually; successful casts remain running.

After restarting the service or closing a sender window, use **Discover TVs** and **Cast all three** again; assignments remain saved. For a lost Cast connection, select **Cast to TV** to retry. Automatic relaunch of physical-TV casting after a restart is not implemented. The browser URL receivers retain their existing automatic reconnection behavior.

Run this on the actual Windows PC. WSL, containers, VLAN boundaries, VPNs, guest Wi-Fi, and AP isolation can prevent Cast discovery even when the normal HTTP receiver works. A remote VPS cannot discover your clinic’s TVs by itself.

If **Cast destination** stays empty, open Chrome’s **Cast** menu in each sender window opened by this app, and allow local network access if prompted. Chrome can defer network discovery until its Cast controls are opened. A TV appearing in your regular Chrome profile does not establish that these separate sender processes can discover it. Check Google Cast support and the shared LAN, then click **Discover TVs** again. If the error mentions WSL, run the Windows setup/start scripts from a Windows copy of the project using Windows Node.js and Google Chrome. Installing Playwright Chromium for queue capture does not install the Google Chrome used by the Cast sender.

The implementation uses the experimental [Chrome DevTools Cast domain](https://chromedevtools.github.io/devtools-protocol/tot/Cast/). Its browser-launch arguments intentionally keep MediaRouter enabled; Playwright’s standard launch arguments disable that feature. The Chrome sandbox is retained and control uses a local pipe, with no debugging TCP port exposed. `QUEUE_CAST_EXECUTABLE` can point to a compatible Chrome executable if Chrome is installed outside its standard location.

## Try the complete demo

The built-in demo has three different queue pages and one shared login. It uses no credentials or patient data.

1. Click **Try the local demo** while all display URLs are empty.
2. Click **Open login browser**.
3. In the separate Chromium window, click **Sign in to demo**.
4. Click **Start display** on each TV card.
5. Click **Discover TVs**, assign three different destinations, and click **Cast all three**. Alternatively, open `http://PC-LAN-IP:8443/tv/1`, `/tv/2`, and `/tv/3` in TV browsers.

The demo has a protected-page marker, so it approves only authenticated queue pages automatically. The live clock makes it easy to check whether frames are updating. To switch to the real site, save the real login URL and replace each display URL and ready selector.

## Use the real queue website

1. Save the website **login URL** in the PC admin panel.
2. Click **Open login browser** and sign in manually in that dedicated Chromium window. This is separate from your regular Chrome profile.
3. In each card’s **Display settings**, save its poli name, queue URL, and resolution. Start with 1080p, 1 frame/second, and 80% JPEG quality.
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

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8443` | HTTP server and receiver port |
| `HOST` | `0.0.0.0` | Listener address; use `127.0.0.1` for PC-only development |
| `QUEUE_DATA_DIR` | Platform-specific folder above | Configuration and dedicated Chromium profile |
| `QUEUE_CAST_EXECUTABLE` | Installed Google Chrome | Optional executable path for Cast sender browsers |

Changing the port or PC IP also changes the TV receiver addresses. The built-in demo URLs must be updated if the port changes.

## Implementation

Node.js provides the HTTP backend and static admin/receiver UI; Playwright is the only runtime package. Each poli uses a separate page in one persistent Chromium context. Shared cookies/storage provide one login when the website supports it. Screenshots are captured without overlapping work within a page and held in memory. Receivers poll JPEG frames and status independently, with timeouts, bounded retry delays, and a blank/offline state on failures.

This first implementation uses HTTP image-frame streaming and status polling. It does not need WebRTC, a build pipeline, a database, or a cloud service. The UI is plain HTML/CSS/JavaScript; the TV script uses ES5 syntax and XMLHttpRequest for older TV browsers. Queue audio is **not transmitted**. Audio announcements require a separate design and test.

Capturing three 4K pages costs more CPU and bandwidth than 1080p. Start at 1 fps and measure on the real PC. The dashboard reports Node server memory only; use Windows Task Manager for Chromium CPU/RAM and total network usage. A frame is withheld if its capture is over 10 seconds old; this does not detect a queue website that itself stops updating.

Playwright references: [persistent browser context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), [page screenshots](https://playwright.dev/docs/screenshots).

## Validation

```powershell
npm run check
npm test
npm run test:browser
npm run test:cast
```

The browser integration test uses temporary data and headless Chromium. It exercises a single shared login, three different streams, LAN admin isolation, selector/manual approval, per-TV refresh/stop, receiver reconnection, service restart with persistent authentication, browser recovery, and desktop/mobile admin layouts. Demo screenshots are written to ignored `test-results/`. It never uses a real account.

Cast control tests use simulated TV responses to verify three different destinations, duplicate prevention, independent stop, partial failures, approval checks, and honest connection status. `test:cast` separately launches three real Chrome for Testing processes and exercises the actual Cast discovery protocol. Neither suite casts content to a physical TV.

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
| Queue calls have no sound | Image-frame streaming is video-only; this version does not carry browser audio. |
| Port already in use | Stop the other instance or choose a different `PORT` and update receiver URLs/firewall. |
| Discover TVs cannot open Chrome | Install Google Chrome on the Windows PC, or set `QUEUE_CAST_EXECUTABLE`. A desktop session must be available. |
| No Cast TVs found | Check Chrome’s own Cast menu, unique TV names, Google Cast support, same LAN, local network permissions, Windows Firewall, and AP isolation. Run on Windows rather than inside WSL. |
| A Cast command succeeds but the TV stays blank | Check the physical TV and status message. Test that TV with Chrome’s normal Cast menu; command acknowledgement alone is not a confirmed session. |
| One cast fails while others work | Leave the working casts running. Check the failed TV, then retry its individual Cast control. |
