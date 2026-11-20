# Tab Bridge (optional)

A small local bridge that lets agents drive the tabs of **your own Chrome**, including sites where you are already signed in. It is off by default. Turn it on only if you want agents to use your browser.

What it can do: list tabs, open/close/move tabs, run JavaScript in a tab, take screenshots, download files with your signed-in session, pause media.

It only listens on `127.0.0.1:8765`. Nothing is sent anywhere else.

## Set up

1. In Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `ext` folder next to this file.
2. Start the server (safe to repeat):
   - macOS / Linux: `bash start-bridge.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File start-bridge.ps1`
3. `OK: Chrome extension connected.` means it is ready. If port 8765 is used by another program, the script stops and tells you; free the port yourself.

## Use

```
node tb.js health
node tb.js tabs [filter]              # id, active, title, url
node tb.js eval <tabId> "document.title"
node tb.js newtab <url> [display]     # opens in the bridge window on that monitor
node tb.js nav <tabId> <url>
node tb.js activate <tabId> ; node tb.js close <tabId>
node tb.js dl <url> [filename]        # Chrome download into your Downloads folder
node tb.js dlstatus
node tb.js shot <tabId> out.png
node tb.js pause-media
node tb.js displays ; node tb.js windows ; node tb.js movetab <tabId> [display]
node tb.js reload                     # reload the extension after its files change
```

The older JSON client still works: `node cmd.js <cmd.json>`.

## Monitors

Chrome cannot open a tab "on monitor 2", so the bridge keeps its own maximized window per monitor and opens new tabs there. Your own windows are not touched. `node tb.js setdisplay primary|secondary|N|any` sets the default.
