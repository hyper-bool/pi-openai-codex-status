# pi-openai-codex-status

Pi extension that shows OpenAI hourly and weekly subscription limits like Codex with a status command.

## Install

### From npm

```bash
pi install npm:pi-openai-codex-status
```

### From GitHub

```bash
pi install git:github.com/NxcOP1891/pi-openai-codex-status
```

## Usage

1. Start pi in interactive mode.
2. Run `/login`.
3. Choose **OpenAI Codex**.
4. Run `/status`.
5. Press `r` to refresh, `esc` or `enter` to close.

## Features

- Reads Codex usage from `https://chatgpt.com/backend-api/wham/usage`
- Shows primary and secondary rate-limit windows
- Shows credits status
- Shows a centered overlay inside pi's TUI
- Caches the last snapshot briefly to make reopening faster

## Notes

- This extension depends on pi's built-in OpenAI Codex login support.
- If you're not logged in, run `/login` and choose **OpenAI Codex** first.
- The command only works in pi's interactive TUI, because it opens a custom overlay.

## License

MIT
