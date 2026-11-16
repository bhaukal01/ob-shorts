# ClipSnipr CLI

Clip long videos into vertical 9:16 shorts from the terminal. Zero
dependencies; talks to the same API the dashboard, the MCP server and the
webhooks use.

```bash
pip install clipsnipr        # or: uvx clipsnipr / pipx run clipsnipr

export CLIPSNIPR_API_KEY=osk_...   # from your account page at clipsnipr.studio

clipsnipr process "https://youtube.com/watch?v=..." --wait
clipsnipr clips <job_id>
clipsnipr publish <job_id> 0 --platforms tiktok,youtube
clipsnipr quota
```

Self-hosted instance? Point it at your own machine and skip the key:

```bash
export CLIPSNIPR_API_URL=http://localhost:8000
clipsnipr process "https://youtube.com/watch?v=..." --wait
```

For pipelines, prefer the webhook to `--wait`: pass `--webhook` and
`--webhook-secret` and ClipSnipr POSTs once (HMAC-signed,
`X-ClipSnipr-Signature: sha256=<hex>`) when the job ends, with clip titles
and durable download links.

The hosted free tier is 20 minutes/month with a watermark; paid plans from
$12/month. The self-hosted edition is MIT and has no meter. Agent-native
version of the same surface: [clipsnipr.studio/mcp](https://www.clipsnipr.studio/mcp).
