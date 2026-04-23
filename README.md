# drift CLI

Command-line client for [AI Drift Detector](https://drift.geniohub.com) — watches your AI coding sessions, detects drift, and lets you checkpoint safely.

Works with Claude Code, OpenAI Codex, and any provider that feeds turns into the AiDrift backend.

## Install

```bash
npm i -g @aidrift/cli
drift auth login
```

That's it. The binary is `drift`. Authentication is handled per-profile in `~/.drift/profiles.json` (mode `0600`).

## Quickstart

```bash
drift auth login                         # paste a personal access token
drift session ensure --provider claude-code   # get-or-create a session for this repo
drift status                             # current drift score, alert band, last stable checkpoint
```

Run `drift --help` for the full command list.

## Companion pieces

- **[aidrift-plugin](https://github.com/geniohub/aidrift-plugin)** — Claude Code plugin that uses this CLI for auto-tracking + MCP tools.
- **[aidrift-vscode](https://github.com/geniohub/aidrift-vscode)** — VSCode extension with a live status bar and session sidebar.
- **[aidrift-plugins](https://github.com/geniohub/aidrift-plugins)** — the Claude Code plugin marketplace (named `geniohub`).

## Configuration

| Env var | Effect |
| --- | --- |
| `AIDRIFT_API_URL` | Override the API host. Default `https://drift.geniohub.com/api`. |
| `AIDRIFT_PROFILE` | Use a non-default profile from `~/.drift/profiles.json`. |

## License

MIT © [GenioHub](https://drift.geniohub.com)
