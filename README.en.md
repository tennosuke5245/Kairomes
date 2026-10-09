<p align="center">
  <img src="apps/desktop/src-tauri/app-icon.svg" width="96" alt="Kairomes logo">
</p>

# Kairomes

[繁體中文](README.md) · English · [日本語](README.ja.md)

[![CI](https://github.com/tennosuke5245/Kairomes/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tennosuke5245/Kairomes/actions/workflows/ci.yml)
[![Latest preview](https://img.shields.io/github/v/release/tennosuke5245/Kairomes?include_prereleases&label=preview)](https://github.com/tennosuke5245/Kairomes/releases)
[![MIT license](https://img.shields.io/badge/license-MIT-2d6a4f)](LICENSE)

Kairomes lets ChatGPT work with project folders on your own computer.

It runs in the background on Windows and receives ChatGPT's requests through the OpenAI Secure MCP Tunnel. Before it edits a file, runs a command, or saves an image, it asks you in a Chrome/Edge side panel. Nothing happens until you approve.

Kairomes does not read your ChatGPT cookies or chat page, and it never sends messages for you. The name comes from Kairo (回路, "circuit") and Hermes, the messenger.

> Current version: [v0.3.0](https://github.com/tennosuke5245/Kairomes/releases/tag/v0.3.0) (preview). See the [changelog](CHANGELOG.md) for what changed. The installer is not signed yet, so Windows may show a SmartScreen warning, and the side panel has to be loaded by hand.
>
> The app interface and the detailed docs are currently in Traditional Chinese only. Button names below are given in Chinese with an English gloss.

## What it does

- Lets ChatGPT read and search the projects you choose. Folders are never uploaded whole; only what ChatGPT asks for is sent back.
- Shows Git branches, changes, diffs, and recent commits (read-only).
- Saves images ChatGPT generates into your project. Each image is previewed in the side panel and written only after you confirm.
- Lets you approve or reject file edits and commands in the side panel. When you reject, you can give a reason and ChatGPT adjusts.
- Offers a time-limited autonomous mode, so ChatGPT doesn't have to ask every time.
- Lets you add other MCP servers from the side panel, either local programs or remote URLs.
- Turns Codex work into a summary you can paste into ChatGPT to pick up where you left off.

Light and dark mode are both supported.

## Installation

You'll need:

- Windows 11 and Chrome or Edge.
- The Kairomes installer and side panel ZIP from [Releases](https://github.com/tennosuke5245/Kairomes/releases/tag/v0.3.0).
- OpenAI's official [`tunnel-client`](https://github.com/openai/tunnel-client/releases/latest). Install the full Windows client and add `tunnel-client.exe` to your PATH.
- Developer mode turned on in ChatGPT. Creating a Tunnel on the OpenAI Platform needs the Tunnels Read + Manage permissions; using one needs Tunnels Read + Use. See the [official guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

### 1. Install the desktop app and side panel

Install and open Kairomes Desktop. The 「總覽」 (Overview) page lists six setup steps. Follow them in order; the first is adding a project folder.

For the side panel, unzip the file, open the extensions page in Chrome/Edge, turn on Developer mode, click "Load unpacked", and pick the folder that contains `manifest.json`. Keep that folder around afterwards.

### 2. Create a Tunnel profile (one time only)

Create a Tunnel on the [OpenAI Platform](https://platform.openai.com/settings/organization/tunnels) and connect it to the ChatGPT workspace you want to use. Note the Tunnel ID and get a Runtime API Key.

In Desktop, on the Tunnel profile step of 「總覽」 (Overview), click 「複製指令」 (Copy command). Then run the following in PowerShell. Paste the copied command when prompted, and replace `tunnel_YOUR_ID` with your Tunnel ID:

~~~powershell
$relay = Read-Host "Paste the local MCP command from Kairomes"
if ($PSVersionTable.PSVersion -lt [version]'7.3' -or $PSNativeCommandArgumentPassing -eq 'Legacy') {
  $relay = $relay.Replace('"', '\"')
}
tunnel-client init `
  --sample sample_mcp_stdio_local `
  --profile kairomes `
  --tunnel-id tunnel_YOUR_ID `
  --mcp-command $relay
~~~

Paste the command exactly as copied. Changing it to backslashes yourself will make parsing fail. If you already have a `kairomes` profile, check it first with `tunnel-client profiles edit kairomes`.

### 3. Connect and pair the side panel

In Desktop, click 「設定金鑰」 (Set key) and save your Runtime API Key. It's stored in Windows Credential Manager. From then on, just open Desktop and it connects on its own; you don't need to run tunnel-client by hand.

Click the extension icon (or press `Alt+Shift+K`) to open the side panel. Paste its Extension ID into Desktop under 「連線設定 › 瀏覽器側欄」 (Connection settings › Browser side panel), click 「儲存並配對」 (Save and pair), then click 「複製連結」 (Copy link) and paste it back into the side panel. If the browser asks whether it can connect to `127.0.0.1` on your machine, allow it.

The pairing link expires after two minutes. Don't share it, and don't paste it into ChatGPT.

### 4. Check it in ChatGPT

Create a developer-mode app in ChatGPT and choose Tunnel with the connection you just made. Ask ChatGPT to "list my projects". If you see the folder you added, you're done. If the tools don't show up, click "Refresh" in the connector settings.

## Everyday use

Day-to-day operation is covered in the [usage guide](docs/usage.md) (Traditional Chinese):

- Desktop overview, project management, and troubleshooting
- Approving requests in the side panel and using autonomous mode
- Following what ChatGPT did in the workbench
- [Saving ChatGPT images](docs/usage.md#保存-chatgpt-圖片)
- [Adding MCP servers and signing in](docs/usage.md#加入-mcp-與登入)
- Continuing work from Codex

## Security

ChatGPT cannot add folders or approve actions on its own. Only you can do that, on your own machine.

One thing to keep in mind: commands and terminals run with your own Windows account's permissions. They are not sandboxed. A command you approve, or one run in autonomous mode, can reach files outside the project or connect to the network.

Never share your Runtime API Key, pairing link, local workbench URL, or diagnostic logs. See [SECURITY.md](SECURITY.md) for details.

Kairomes is an independent open-source project. It is not endorsed by OpenAI and is not listed in the public ChatGPT store.

## Development

See the [contributing guide](CONTRIBUTING.md) for build steps and checks, and read the [code of conduct](CODE_OF_CONDUCT.md) before contributing. The code is released under the [MIT license](LICENSE).
