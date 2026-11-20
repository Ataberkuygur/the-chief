# The Chief

A Claude Code plugin for running a team of AI agents from one chat. One lead chat (the chief) splits the work and hands it to headless workers on different CLIs and models, watches them live, stops or steers them, and writes short overviews of what got done.

Made by Ataberk Uygur. Free, MIT licence.

## What it does

- **`/chief`**: every running agent and subagent in one list, with model, time and what it is doing now. Open one to read its output, stop it or send it a follow-up. Settings, provider keys and sign-ins live here too.
- **`/squad`**: plan a squad per task (CLI, model, effort, how many agents) and launch it.
- **`/overview`**: a plain summary of what is done, what is running and what needs you.
- **Prompts** (`/chief` → Prompts): save prompts (typed in, or from an agent with "Save prompt"), then copy or delete them. They stay on your computer in `~/.claude/the-chief/prompts.json`, never in the plugin folder.
- **`/goals`**, **`/consult <question>`** (a read-only second opinion from another model), **`/leader`** (one chat that runs several chief chats), **`/live`** (an optional private live page on claude.ai), **`/stop-loops`**.
- Tools for the lead Claude: `spawn_worker`, `list_agents`, `agent_output`, `stop_agent`, `message_agent`, `consult`, and the chief tools (`create_chief`, `list_chiefs`, `message_chief`, ...).
- Workers can run on Claude Code, Codex, Devin, Cursor, Qoder, Gemini, OpenRouter, OpenCode (Zen / Go) or any OpenAI-compatible endpoint. With no API key, each CLI uses its own login.
- Context guards: compacts long chats before they get expensive, caps huge file reads, refuses very short wake-up loops.
- English by default; Turkish when Claude Code's `language` setting or your system is Turkish. Set the `language` option to `en` or `tr` to fix it.

## Requirements

- Claude Code 2.1.286 or newer with function hooks enabled: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The function-hook API is early access and can change between releases.
- The agent CLIs you want to use, on your PATH (at least `claude`).
- Windows or macOS. Built and used mostly on Windows; some extras (the heavy-command gate, the merge train, opening goals in a new terminal) are Windows-first.
- Pinning, Remote Control and session titles need the Claude desktop app (Code tab). In a plain terminal those parts are skipped.
- For the optional Chrome bridge: Node.js 18+ and Chrome 116+.

## Install

From GitHub, in a terminal:

```bash
claude plugin marketplace add Ataberkuygur/the-chief
claude plugin install the-chief@the-chief
```

Claude desktop app: upload `the-chief-<version>.zip` as a plugin.

From the zip, in a terminal:

1. Unzip `the-chief-<version>.zip` into a folder, for example `the-chief-<version>`.
2. In a terminal:

```bash
claude plugin marketplace add /path/to/the-chief-<version>
claude plugin install the-chief@the-chief
claude plugin list
```

3. Close and reopen your Claude Code chats: the plugin loads in new chats only.
4. Type `/chief` to open it. Change options in `/chief` → Settings or with `claude plugin configure the-chief@the-chief`.

To remove it: `claude plugin uninstall the-chief`.

## First-run setup

After your first reply in a new chat, The Chief asks five short questions, the safe answer first. Until you answer, everything below stays off. Closing the dialog keeps it all off. Run it again any time with `/chief setup` or `/chief` → Settings → **Run setup again**.

## Off by default (turn on only if you want it)

| Setting | What it does when on |
|---|---|
| `chief_permission_mode` = `auto` | New chief chats open in auto mode and work without approval cards. Default `off` asks before acting. |
| `tab_bridge` | Installs the bundled Chrome bridge and tells agents to use **your real Chrome**, including sites where you are signed in. |
| `chief_remote_control` | Turns Remote Control on for every working chat, so you can follow it from your phone. |
| `api_credit_fallback` | Lets Claude workers spend the `ANTHROPIC_API_KEY` from your environment (paid API credit) up to `api_daily_usd` per day. |
| `summary_engine` = `auto` | Downloads a small local model (0.5–1.3 GB) and a llama.cpp server to write agent status lines. Default `ask` never downloads. |

Also good to know:

- Claude workers can edit files in their folder (`claude_permission` = `acceptEdits`); `bypassPermissions` is your choice only.
- The plugin adds a short "do the smallest complete change" coding rule (`skills/ponytail/SKILL.md`) to every chat.
- Nothing is pushed to a git remote unless you ask. The merge train runs only if you create its config (`hq/train/config.json`).
- `/live` makes a private claude.ai page only when you type it.
- Workers of other CLIs (Codex, Devin, Gemini, Qoder, Cursor, Antigravity, OpenCode) run headless with their own approval prompts switched off, because they cannot stop to ask you mid-run. Start them only in folders you are fine with them changing.
- Consultants: before a decision that is hard to undo, a chief may ask the CLIs listed in `consultants` (by default Codex, Devin and a stronger Claude) for a second opinion. The question and the files it needs go to those providers through your own logins. Empty the list to turn this off.
- On Windows, the RAM gate (`heavy_gate`) pauses heavy builds (tsc, vitest, dependency-cruiser) that agents start when RAM is short, and under 1.8 GB free ends the newest one. It never touches commands you start in your own terminal or editor. The plugin also ends headless `opencode run` processes left without a parent, ends build processes inside a lane folder when that lane is cleaned up, and compiles a small process-list helper (`procsnap.exe`) locally with the .NET compiler that ships with Windows.
- No telemetry: the plugin sends nothing about you or your work anywhere by itself. The one automatic network call: if OpenCode is installed (or a Zen key is set), a few times a day it asks opencode.ai which free models are up, with a one-word "ping" per model. Without OpenCode it never contacts opencode.ai.
- `summary_engine` = `auto` downloads llama.cpp and the model over HTTPS from GitHub and Hugging Face without a separate checksum check. `stale_locks` (empty by default) deletes the folders you list in it.
- The Chrome bridge has no password: any program already running on your own computer can use it while it is on. Web pages cannot.
- The Chief is not affiliated with the makers of the other CLIs and models it can run (Codex, Devin, Gemini, Qoder, Cursor, OpenCode and others).

## Optional: Chrome tab bridge

A small local server (`127.0.0.1:8765`) plus a Chrome extension. When `tab_bridge` is `on`, agents can list your tabs, open and move tabs, run JavaScript in a page, take screenshots, download files with your signed-in session and pause media. It listens only on your own computer and refuses requests from web pages: only the extension and local tools can use it. Setup steps are in [`tab-bridge/README.md`](tab-bridge/README.md).

Only turn it on if you are fine with agents acting inside your logged-in browser.

**Warning:** automating a site where you are signed in can break that site's terms of service, and some sites close accounts for it. The bridge has none of the safety checks of Claude in Chrome (site blocks, confirmations before sensitive actions). You are responsible for what agents do through it; prefer read-only use on accounts you cannot afford to lose. If the Chrome extension is not connected, agents simply use Claude in Chrome.

## Logs and files

- Worker logs: `.squad/logs/` in the project.
- Handoff notes when a long chat moves to a fresh one: `.chief/` in the project.
- Plugin state: `~/.claude/the-chief/`.

## Develop

```bash
claude plugin validate .
```

`hooks/bridge-files.ts` is generated from `tab-bridge/`: run `node scripts/build-bridge.mjs` after changing the bridge.

## Licence

MIT, see [LICENSE](LICENSE).

Third-party parts keep their own licences: `skills/ponytail` (MIT, DietrichGebert, see its LICENSE) and the `ws` library in `tab-bridge/node_modules/ws` (MIT, see its LICENSE). The Chief is an independent project and is not affiliated with or endorsed by Anthropic.
