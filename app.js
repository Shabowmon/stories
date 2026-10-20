// Stories v1 — loads text stories and reads them aloud with the browser's
// built-in speech engine (Web Speech API).

const LIBRARY_DIR = "library/";
const WORDS_PER_MIN = 160; // rough speaking pace at 1x, used for duration estimates

const state = {
  stories: [],   // parsed stories, in manifest order
  current: null, // { story, index } — the selected episode
};

const $ = (id) => document.getElementById(id);

// Escape text before putting it into innerHTML so story text can't inject markup.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Parsing ----------

// Turns a story .txt file into { id, title, hero, genre, colors, blurb, episodes[] }.
// Format: "Key: value" lines at the top, then "## Episode N: Title" headings.
function parseStory(text, file) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const story = { id: file.replace(/\.txt$/, ""), title: file, hero: "", genre: "", colors: [], blurb: "", episodes: [] };
  let episode = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      episode = { title: heading[1].trim(), lines: [] };
      story.episodes.push(episode);
    } else if (episode) {
      episode.lines.push(line);
    } else {
      const meta = line.match(/^(\w+):\s*(.*)$/);
      if (!meta) continue;
      const key = meta[1].toLowerCase();
      const value = meta[2].trim();
      if (key === "colors") story.colors = value.split(",").map((c) => c.trim());
      else if (key in story) story[key] = value;
    }
  }

  // Join each episode's lines into paragraphs (blank line = new paragraph).
  for (const ep of story.episodes) {
    ep.paragraphs = ep.lines.join("\n").split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
    ep.words = ep.paragraphs.join(" ").split(" ").length;
    delete ep.lines;
  }
  return story;
}

async function loadLibrary() {
  const files = await (await fetch(LIBRARY_DIR + "index.json")).json();
  const texts = await Promise.all(files.map((f) => fetch(LIBRARY_DIR + f).then((r) => (r.ok ? r.text() : null))));
  // Skip files that are missing (e.g. a typo in index.json) or have no "## " episodes.
  state.stories = texts
    .map((t, i) => (t === null ? console.warn(`Story not found: ${files[i]}`) : parseStory(t, files[i])))
    .filter((s) => s && (s.episodes.length || console.warn(`No "## " episodes in ${s.id}.txt`)));
}

// ---------- Rendering ----------

function initials(title) {
  return title.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

function coverStyle(story) {
  const [c1, c2] = story.colors;
  return `${c1 ? `--c1:${esc(c1)};` : ""}${c2 ? `--c2:${esc(c2)};` : ""}`;
}

function minutes(words) {
  return Math.max(1, Math.round(words / WORDS_PER_MIN));
}

function renderLibrary() {
  $("library").innerHTML = state.stories.map((s) => `
    <button class="card" data-id="${esc(s.id)}">
      <div class="cover" style="${coverStyle(s)}">${esc(initials(s.title))}</div>
      <div class="card-body">
        <div class="card-title">${esc(s.title)}</div>
        <div class="card-meta">${s.episodes.length} episodes · ${esc(s.genre)}</div>
      </div>
    </button>`).join("");
}

function openStory(id) {
  const s = state.stories.find((x) => x.id === id);
  if (!s) return;
  const total = s.episodes.reduce((n, ep) => n + ep.words, 0);

  $("story-detail").innerHTML = `
    <div class="story-head">
      <div class="cover big" style="${coverStyle(s)}">${esc(initials(s.title))}</div>
      <div>
        <h2 class="story-title">${esc(s.title)}</h2>
        <div class="card-meta">${esc(s.hero)}</div>
        <div class="card-meta">${esc(s.genre)} · ${s.episodes.length} episodes · ~${minutes(total)} min</div>
      </div>
    </div>
    <p class="blurb">${esc(s.blurb)}</p>
    <ol class="episodes">
      ${s.episodes.map((ep, i) => `
        <li>
          <button class="episode" data-story="${esc(s.id)}" data-index="${i}">
            <span class="ep-num">${i + 1}</span>
            <span class="ep-title">${esc(ep.title.replace(/^Episode \d+:\s*/, ""))}</span>
            <span class="ep-len">${minutes(ep.words)} min</span>
          </button>
        </li>`).join("")}
    </ol>`;

  $("library-view").classList.add("hidden");
  $("story-view").classList.remove("hidden");
  window.scrollTo(0, 0);
  markCurrentEpisode();
}

function showLibrary() {
  $("story-view").classList.add("hidden");
  $("library-view").classList.remove("hidden");
}

// Highlight the selected episode in the open story's list.
function markCurrentEpisode() {
  document.querySelectorAll(".episode").forEach((el) => {
    const c = state.current;
    el.classList.toggle("current", !!c && c.story.id === el.dataset.story && c.index === Number(el.dataset.index));
  });
}

// ---------- Player ----------
//
// The browser's speech engine reads one "chunk" (a sentence or two) at a time.
// Short chunks dodge a Chrome bug where long utterances silently stop after
// ~15 seconds, and let pause/speed changes restart from a nearby point.
//
// Pause is done as cancel + remember position, not speechSynthesis.pause(),
// because pause() is unreliable on Android and some Linux voices.

const MAX_CHUNK = 160; // characters
const synth = window.speechSynthesis;

Object.assign(state, {
  chunks: [],    // text pieces of the current episode, in order
  pos: 0,        // index of the chunk being read
  playing: false,
  rate: 1,
  gen: 0,      // bumped on every start/stop so stale speech callbacks are ignored
});

// Split an episode into chunks: title first, then sentences grouped up to MAX_CHUNK.
function chunkEpisode(ep) {
  const chunks = [ep.title + "."];
  for (const para of ep.paragraphs) {
    const raw = (para.match(/[^.!?]+[.!?]+["'”’)]*\s*|[^.!?]+$/g) || [para]).map((s) => s.trim());
    // "Mr." / "Dr." aren't sentence ends: glue them back onto what follows.
    const sentences = [];
    for (const s of raw) {
      const prev = sentences[sentences.length - 1];
      if (prev && /\b(Mr|Mrs|Ms|Dr|St)\.$/.test(prev)) sentences[sentences.length - 1] = prev + " " + s;
      else sentences.push(s);
    }
    // A very long sentence gets split again at commas.
    const pieces = sentences.flatMap((s) => (s.length > MAX_CHUNK ? s.split(/(?<=,)\s+/) : [s]));
    let buf = "";
    for (const piece of pieces) {
      if (buf && (buf + " " + piece).length > MAX_CHUNK) {
        chunks.push(buf.trim());
        buf = "";
      }
      buf += " " + piece;
    }
    if (buf.trim()) chunks.push(buf.trim());
  }
  return chunks;
}

function selectEpisode(storyId, index, autoplay = true) {
  const story = state.stories.find((x) => x.id === storyId);
  if (!story || !story.episodes[index]) return;
  stopSpeech();
  state.current = { story, index };
  state.chunks = chunkEpisode(story.episodes[index]);
  state.pos = 0;

  $("np-cover").setAttribute("style", coverStyle(story));
  $("np-title").textContent = story.episodes[index].title;
  markCurrentEpisode();
  if (autoplay) play();
  else updatePlayer();
}

function speakCurrent() {
  const gen = ++state.gen;
  synth.cancel();

  if (state.pos >= state.chunks.length) return finishEpisode();

  const u = new SpeechSynthesisUtterance(state.chunks[state.pos]);
  u.lang = "en-US";
  u.rate = state.rate;
  u.onend = () => {
    if (gen !== state.gen) return; // this utterance was cancelled by a newer action
    state.pos++;
    speakCurrent();
  };
  u.onerror = (e) => {
    if (gen !== state.gen || e.error === "interrupted" || e.error === "canceled") return;
    console.warn("Speech error:", e.error);
    state.pos++; // skip the bad chunk rather than stalling
    speakCurrent();
  };
  synth.speak(u);
  updatePlayer();
}

// Autoplay the next episode, like Pocket FM. At the end of the story, stop.
function finishEpisode() {
  const { story, index } = state.current;
  if (index + 1 < story.episodes.length) {
    selectEpisode(story.id, index + 1);
  } else {
    stop();
    $("np-sub").textContent = `${story.title} · The end`;
  }
}

function stopSpeech() {
  state.playing = false;
  state.gen++;
  synth.cancel();
}

function play() {
  if (!state.current) return;
  state.playing = true;
  speakCurrent();
}

function pause() {
  stopSpeech();
  updatePlayer();
}

function stop() {
  stopSpeech();
  state.pos = 0;
  updatePlayer();
}

function next() {
  if (!state.current) return;
  const { story, index } = state.current;
  if (index + 1 < story.episodes.length) selectEpisode(story.id, index + 1, state.playing);
}

function setRate(rate) {
  state.rate = rate;
  document.querySelectorAll(".speed").forEach((b) => b.classList.toggle("active", Number(b.dataset.rate) === rate));
  if (state.playing) speakCurrent(); // restart the current chunk at the new speed
  else updatePlayer();
}

// Sync buttons, progress bar, and "time left" with the current state.
function updatePlayer() {
  const c = state.current;
  $("play-btn").disabled = $("stop-btn").disabled = !c;
  $("next-btn").disabled = !c || c.index + 1 >= c.story.episodes.length;
  $("play-btn").textContent = state.playing ? "❚❚" : "▶";
  $("play-btn").setAttribute("aria-label", state.playing ? "Pause" : "Play");
  if (!c) return;

  const lens = state.chunks.map((t) => t.length);
  const total = lens.reduce((a, b) => a + b, 0);
  const done = lens.slice(0, state.pos).reduce((a, b) => a + b, 0);
  $("progress-fill").style.width = `${total ? (done / total) * 100 : 0}%`;

  const wordsLeft = state.chunks.slice(state.pos).join(" ").split(/\s+/).length;
  const minsLeft = Math.max(1, Math.round(wordsLeft / (WORDS_PER_MIN * state.rate)));
  $("np-sub").textContent = `${c.story.title} · ${minsLeft} min left`;

  renderContinue(minsLeft);
  saveProgress();
}

// ---------- Resume where you left off ----------
//
// Saved in localStorage: this browser only, and it's fine if it's lost.

const RESUME_KEY = "stories-resume";

function saveProgress() {
  const c = state.current;
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify({ story: c.story.id, index: c.index, pos: state.pos, rate: state.rate }));
  } catch {}
}

function restoreProgress() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(RESUME_KEY)); } catch {}
  if (!saved) return;
  if (document.querySelector(`.speed[data-rate="${saved.rate}"]`)) setRate(saved.rate);
  selectEpisode(saved.story, saved.index, false);
  if (!state.current) return; // story no longer in the library
  state.pos = Math.min(Math.max(0, saved.pos | 0), state.chunks.length - 1);
  updatePlayer();
}

// Banner above the library while something is paused mid-episode.
function renderContinue(minsLeft) {
  const c = state.current;
  const show = c && !state.playing && state.pos > 0;
  $("continue").classList.toggle("hidden", !show);
  if (!show) return;
  $("continue").innerHTML = `
    <div class="np-cover" style="${coverStyle(c.story)}"></div>
    <div class="np-text">
      <div class="continue-label">Continue listening</div>
      <div class="np-title">${esc(c.story.episodes[c.index].title)}</div>
      <div class="np-sub">${esc(c.story.title)} · ${minsLeft} min left</div>
    </div>
    <span class="continue-play" aria-hidden="true">▶</span>`;
}

// ---------- Wiring ----------

$("library").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (card) openStory(card.dataset.id);
});

$("story-detail").addEventListener("click", (e) => {
  const ep = e.target.closest(".episode");
  if (ep) selectEpisode(ep.dataset.story, Number(ep.dataset.index));
});

$("back-to-library").addEventListener("click", showLibrary);
$("continue").addEventListener("click", play);

$("play-btn").addEventListener("click", () => (state.playing ? pause() : play()));
$("stop-btn").addEventListener("click", stop);
$("next-btn").addEventListener("click", next);
document.querySelector(".speeds").addEventListener("click", (e) => {
  const b = e.target.closest(".speed");
  if (b) setRate(Number(b.dataset.rate));
});

// Spacebar = play/pause (unless a button has focus — then space clicks it already).
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.target.closest("button, input, textarea")) return;
  e.preventDefault();
  if (state.current) state.playing ? pause() : play();
});

// Some browsers keep talking after you reload or leave the page.
window.addEventListener("pagehide", () => synth && synth.cancel());

if (!synth) {
  $("np-sub").textContent = "This browser can't read aloud (no speech support)";
}

loadLibrary()
  .then(() => {
    renderLibrary();
    restoreProgress();
  })
  .catch((err) => {
    console.error(err);
    $("library").innerHTML = `<p class="empty">Couldn't load stories. If you opened this file directly, run a local server instead (see README).</p>`;
  });
