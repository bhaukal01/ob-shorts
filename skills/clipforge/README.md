# ClipForge as an Agent Skill

`SKILL.md` plus `reference.md` are an
[Agent Skill](https://github.com/agentskills/agentskills): an open standard
adopted by 26+ agent products, so this one folder installs in Claude Code,
OpenClaw, Hermes, Codex, Gemini CLI, Cursor and VS Code without changes.

It teaches an agent to turn a long video into vertical 9:16 clips through the
ClipForge API: which options actually produce good clips, which responses look
like errors but are not, and when to stop and ask the user.

## Setup

Create an API key (`osk_...`) in your account page at
[clipforge.studio](https://www.clipforge.studio/) and give it to the agent the way
that host stores credentials (`CLIPFORGE_API_KEY` where an env var is the
convention). The hosted free tier includes 20 minutes of source video per month
with a watermark; paid plans start at $12/month without one. ClipForge is also
MIT-licensed and self-hostable, which needs a GPU machine, your own Google
Gemini key, and your own [Upload-Post](https://www.upload-post.com/) account for
the publishing steps.

If the host speaks MCP, add the server too so the agent gets typed tools instead
of raw HTTP:

```bash
claude mcp add --transport http clipforge https://mcp.clipforge.studio/mcp \
  --header "Authorization: Bearer osk_..."
```

The skill works either way: with MCP it calls the tools, without it it calls the
REST API documented in `reference.md`.

## Install

**Claude Code.** Copy the folder into `~/.claude/skills/` for every project, or
a project's `.claude/skills/` for one:

```bash
cp -r skills/clipforge ~/.claude/skills/
```

**OpenClaw.** Copy it into your OpenClaw `skills/` directory, or install from
git with `openclaw add <owner>/<repo>`.

**Hermes.** Skills live in `~/.hermes/skills/`; installing from the marketplace
runs a security scan first.

**Anything else.** Drop the folder wherever that agent reads skills from.

## Related

- `cli/` is the same API as a zero-dependency CLI: `uvx clipforge process <url> --wait`.
- `examples/n8n/` has the same pipeline as importable n8n workflows, including a
  daily channel autopilot with Telegram approval.
- [clipforge.studio/mcp](https://www.clipforge.studio/mcp) documents the MCP server,
  and [api.clipforge.studio/docs](https://api.clipforge.studio/docs) the full API.
