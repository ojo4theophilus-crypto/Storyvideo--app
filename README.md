# StoryVideo — Idea to Video

Paste a story or idea. It automatically:
1. Breaks it into scenes (free, no key — Pollinations text API)
2. Generates an image per scene (free, no key — Pollinations image API)
3. Generates narration audio per scene (needs one free Pollinations account/key)
4. Builds a Ken Burns-style zoom/pan clip per scene (ffmpeg)
5. Stitches everything into one final .mp4 you can download

No manual editing. One button.

## Before you deploy: get one free key (for narration only)

1. Go to https://enter.pollinations.ai and sign up (free, no card).
2. Create a key starting with `sk_`.
3. Keep it somewhere safe — you'll paste it into Render as an environment variable.

Everything else (scene writing, images) needs no key at all.

## Deploy on Render (free tier)

1. Create a free account at https://render.com
2. Push this project's files to a new GitHub repository (or use Render's "Upload" option if available for your account).
3. In Render, click **New +** → **Web Service** → connect your repo.
4. Settings:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Under **Environment Variables**, add:
   - `POLLINATIONS_API_KEY` = the `sk_...` key from step above
6. Click **Create Web Service**. Wait for the first deploy (a few minutes).
7. Open the live URL Render gives you — that's your app.

## Using it

1. Open your app's URL.
2. Paste a story or idea into the box.
3. Click **Generate video**.
4. Wait — a progress bar and log show what's happening (scenes → images → narration → assembly). A ~7-10 minute video may take several minutes to generate.
5. When done, preview it right in the page and click **Download video**.

## Notes and honest limitations

- **Free tier sleep**: Render's free web services spin down after inactivity and take ~30-60 seconds to wake up on the next visit. Not a bug — just free-tier behavior.
- **Generation time**: More scenes = more images + audio + ffmpeg work = longer wait. A 5-10 min video with ~8-10 scenes typically takes several minutes to fully generate.
- **Third-party free APIs can change**: Pollinations is a free public service. If an endpoint changes shape or goes down temporarily, the app will show a clear error message in the log — check https://github.com/pollinations/pollinations for current endpoint docs if something breaks.
- **Storage**: Generated videos are saved in the app's `public/output` folder. Render's free disk is ephemeral — files may be cleared on redeploy/restart, so download videos you want to keep rather than leaving them on the server.
- **Content**: Anything you generate is still subject to Pollinations' own usage policies as a third-party service.

## Running locally (optional, to test before deploying)

```bash
npm install
cp .env.example .env
# edit .env and paste your POLLINATIONS_API_KEY
npm start
```

Then open http://localhost:3000
