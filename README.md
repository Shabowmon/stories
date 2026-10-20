# Stories

Pocket FM-style audio stories: plain-text stories read aloud by the browser's
built-in text-to-speech (Web Speech API). Play / pause / stop / next, speeds
1x–3x, autoplay to the next episode, and "Continue listening" where you left off.

Static site (same pattern as lifts/recipes/signals): plain HTML/CSS/JS, no build
step, no backend, no audio files.

## What's inside

- `index.html` — page shell (library, story view, player bar)
- `styles.css` — dark minimal theme, phone-friendly
- `app.js` — loads and parses stories, renders the library, drives speech
- `library/index.json` — list of story files to load, in display order
- `library/*.txt` — the stories (2 seed stories, 5 episodes each)

## Adding a story

1. Write `library/my-story.txt` in this format:

   ```
   Title: My Story
   Hero: Name, 16
   Genre: Young Adult · Growth
   Colors: #1f3b3a, #e8a33d
   Blurb: One or two sentences for the story page.

   ## Episode 1: First Title
   Paragraphs, separated by blank lines.

   ## Episode 2: Second Title
   ...
   ```

   `Colors` are the two ends of the generated cover gradient. Each `## ` line starts a new episode.
2. Add `"my-story.txt"` to `library/index.json`.
3. Push.

## Local dev

The page loads the story files with `fetch`, which browsers block on `file://`,
so serve the folder instead of double-clicking `index.html`:

```bash
cd ~/Projects/web/stories
python3 -m http.server 8765
# open http://127.0.0.1:8765
```

## How playback works

- Each episode is split into chunks of a sentence or two (≤160 chars). Chrome
  silently stops long utterances after ~15s; short chunks avoid that.
- Pause = cancel + remember the chunk index (`speechSynthesis.pause()` is
  unreliable on Android/Linux). Resume and speed changes replay the current chunk.
- A generation counter (`state.gen`) ignores "finished" events from speech that
  was cancelled, so pause doesn't immediately skip ahead.
- Resume position + speed: `localStorage` key `stories-resume` (this browser only).

## Voices

The voice comes from the listener's device, not the site: good on iPhone/Mac,
Windows (Edge "Natural" voices), Android and Chrome; robotic on stock Linux (espeak).

On Robert's Fedora box, Piper (neural, offline) is wired in as the default
speech-dispatcher voice (Ryan), so Firefox and Chrome use it:

- `~/.local/share/piper/` — Piper binary, voices (ryan, lessac, amy), `piper-speak.sh` wrapper, `speak.log`
- `~/.config/speech-dispatcher/` — copy of the system config + Piper as `DefaultModule`
- Undo: `rm -r ~/.config/speech-dispatcher ~/.local/share/piper`
- After changing it: quit the browser fully, and `pkill -x speech-dispatch`.

## Deploy (same dance as lifts/recipes/signals)

```bash
cd ~/Projects/web/stories
git init -b main
git add -A
git commit -m "Stories v1"
gh repo create Shabowmon/stories --public --source=. --push
```

Then in Cloudflare (Workers & Pages → Create an app):
1. Select the `Shabowmon/stories` repository.
2. Project name: `stories`.
3. Build command: *(leave empty)*.
4. Deploy command: `npx wrangler deploy`.
5. Deploy, then add custom domain `stories.robertnaanos.com`
   (Worker → Domains → Add Domain).

Pushes to `main` auto-deploy.
