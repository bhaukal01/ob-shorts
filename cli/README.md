# ClipForge CLI

Clip long videos into vertical 9:16 shorts from the terminal. Zero
dependencies; talks to the same API the dashboard, the MCP server and the
webhooks use.

```bash
pip install clipforge        # or: uvx clipforge / pipx run clipforge

export CLIPFORGE_API_KEY=osk_...   # from your account page at clipforge.studio

clipforge process "https://youtube.com/watch?v=..." --wait
clipforge clips <job_id>
clipforge publish <job_id> 0 --platforms tiktok,youtube
clipforge quota
```

Self-hosted instance? Point it at your own machine and skip the key:

```bash
export CLIPFORGE_API_URL=http://localhost:8000
clipforge process "https://youtube.com/watch?v=..." --wait
```

For pipelines, prefer the webhook to `--wait`: pass `--webhook` and
`--webhook-secret` and ClipForge POSTs once (HMAC-signed,
`X-ClipForge-Signature: sha256=<hex>`) when the job ends, with clip titles
and durable download links.

The hosted free tier is 20 minutes/month with a watermark; paid plans from
$12/month. The self-hosted edition is MIT and has no meter. Agent-native
version of the same surface: [clipforge.studio/mcp](https://www.clipforge.studio/mcp).
