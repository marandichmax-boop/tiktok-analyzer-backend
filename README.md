
# TikTok Analyzer Backend

Endpoints:
- POST /jobs        { tiktokUrl } -> { id, status }
- GET  /jobs/:id    -> { status, transcript, analysis }
- POST /scripts     { title, sourceUrl, transcript, analysis } -> { id }
- GET  /scripts     -> list recent scripts

## Deploy on Render (fastest)
1) Create a new GitHub repo and upload these files.
2) On Render: New -> Web Service -> Connect your repo.
3) Environment -> Add `AAI_KEY` with your AssemblyAI API key (Bearer value, e.g., `YOUR_KEY`).
4) Render detects the Dockerfile automatically.
5) Deploy. After it's live, you'll get a URL like:
   https://tiktok-analyzer-backend.onrender.com
6) Paste that URL into the canvas app's "Backend Base URL" field.

## Local dev
AAI_KEY=YOUR_ASSEMBLY_AI_KEY node server.js
