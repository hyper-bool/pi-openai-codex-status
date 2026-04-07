# pi-openai-codex-status

A pi extension that adds `/status` to show OpenAI Codex usage, credits, and rate limits in an interactive TUI overlay.

## Install

### From npm

```bash
pi install npm:pi-openai-codex-status
```

### From GitHub

```bash
pi install git:github.com/YOUR_GITHUB_NAME/pi-openai-codex-status
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

## Local development

You can test the package before publishing:

```bash
pi -e ./extensions/openai-status.ts
```

Or install it locally as a pi package:

```bash
pi install .
```

## Publish checklist

1. Replace `YOUR_GITHUB_NAME` in `package.json` and this README.
2. Create the GitHub repo.
3. Push this folder to GitHub.
4. Run `npm login`.
5. Run `npm publish --dry-run`.
6. Run `npm publish`.

## Notes

- This extension depends on pi's built-in OpenAI Codex login support.
- If you're not logged in, run `/login` and choose **OpenAI Codex** first.
- The command only works in pi's interactive TUI, because it opens a custom overlay.

## License

MIT
