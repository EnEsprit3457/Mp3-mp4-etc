// Clipper : trouve automatiquement les moments forts d'une vidéo
// et les transforme en clips verticaux (9:16) pour TikTok, Reels, Shorts.
//
// Comment on trouve les "moments forts" ?
// On écoute le son de la vidéo : les passages où ça crie, rigole ou s'enflamme
// sont plus forts que d'habitude. On garde les pics de volume les plus marqués.

import { createEngine, formatSize } from './engine.js';

const $ = (id) => document.getElementById(id);
const el = {
  fileInput: $('fileInput'), dropzone: $('dropzone'), dzText: $('dzText'), fileInfo: $('fileInfo'),
  settingsCard: $('settingsCard'), runCard: $('runCard'), galleryCard: $('galleryCard'),
  notice: $('notice'), runBtn: $('runBtn'), cancelBtn: $('cancelBtn'),
  progressWrap: $('progressWrap'), progressBar: $('progressBar'), statusText: $('statusText'),
  errorText: $('errorText'), gallery: $('gallery'), galleryInfo: $('galleryInfo'), shareTip: $('shareTip'),
};

const SAMPLE_RATE = 4000;   // on analyse le son en basse qualité : c'est suffisant et rapide
const OUT_W = 720;          // taille des clips : 720 × 1280 (format vertical 9:16)
const OUT_H = 1280;

const state = {
  file: null,
  duration: 0,
  settings: { count: 5, length: 30, layout: 'crop' },
  busy: false,
  cancelled: false,
  clips: [],                // { url, name, card }
};

let ffmpeg = null;
let wakeLock = null;
let logLines = [];
let progressTarget = 0;     // durée (s) du traitement en cours, pour la barre de progression
let onTime = null;          // appelé quand FFmpeg indique où il en est

// ---------------------------------------------------------------------------
// Petites aides
// ---------------------------------------------------------------------------
function clock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function minutes(sec) {
  return sec < 90 ? `${Math.max(1, Math.round(sec))} s` : `${Math.round(sec / 60)} min`;
}

function setProgress(ratio, text) {
  el.progressBar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  if (text) el.statusText.textContent = text;
}

function showError(msg) { el.errorText.textContent = msg; el.errorText.hidden = false; }
function hideError() { el.errorText.hidden = true; }

function parseClock(str) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(str);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
}

function onLog(message) {
  logLines.push(message);
  if (logLines.length > 400) logLines.shift();
  if (!state.duration) {
    const d = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(message);
    if (d) state.duration = parseClock(d[1]);
  }
  const t = /time=\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(message);
  if (t && onTime) onTime(parseClock(t[1]));
}

function readDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 0); };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(0);
    setTimeout(() => done(0), 5000);
    v.src = url;
  });
}

// ---------------------------------------------------------------------------
// Étape 1 : choix de la vidéo
// ---------------------------------------------------------------------------
async function handleFile(file) {
  if (!file || state.busy) return;
  hideError();
  state.file = file;
  state.duration = 0;
  el.dzText.textContent = file.name;
  el.fileInfo.hidden = false;
  el.fileInfo.textContent = `🎬 ${formatSize(file.size)}`;

  state.duration = await readDuration(file);
  if (state.duration) el.fileInfo.textContent += ` · ${clock(state.duration)}`;

  el.settingsCard.hidden = false;
  el.runCard.hidden = false;
  updateNotice();
}

el.fileInput.addEventListener('change', () => handleFile(el.fileInput.files[0]));
['dragenter', 'dragover'].forEach((t) => el.dropzone.addEventListener(t, (e) => {
  e.preventDefault(); el.dropzone.classList.add('drag');
}));
['dragleave', 'drop'].forEach((t) => el.dropzone.addEventListener(t, (e) => {
  e.preventDefault(); el.dropzone.classList.remove('drag');
}));
el.dropzone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

// ---------------------------------------------------------------------------
// Étape 2 : réglages
// ---------------------------------------------------------------------------
document.querySelectorAll('.choices').forEach((group) => {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || state.busy) return;
    group.querySelectorAll('button').forEach((b) => b.classList.toggle('selected', b === btn));
    const v = btn.dataset.value;
    state.settings[group.dataset.name] = Number.isNaN(Number(v)) ? v : Number(v);
    updateNotice();
  });
});

function updateNotice() {
  const { count, length } = state.settings;
  const lines = [
    `⏳ Sur téléphone, compte environ ${minutes(count * length * 3)} pour ${count} clips de ${length} s (un peu moins sur ordinateur). Les clips apparaissent au fur et à mesure : tu peux commencer à trier pendant que les suivants se créent.`,
    "🔆 Reste sur cette page et garde l'écran allumé.",
  ];
  if (state.duration > 1800) {
    lines.push(`🎞️ Ta vidéo dure ${clock(state.duration)} : l'analyse du son prendra quelques minutes avant le premier clip.`);
  }
  if (state.duration && state.duration < state.settings.length * state.settings.count) {
    lines.push('ℹ️ Ta vidéo est courte : il y aura sûrement moins de clips que demandé.');
  }
  el.notice.replaceChildren(...lines.map((t) => Object.assign(document.createElement('p'), { textContent: t })));
}

// ---------------------------------------------------------------------------
// Étape 3 : analyse du son puis création des clips
// ---------------------------------------------------------------------------

// Volume (en décibels) de chaque seconde de la vidéo
function loudnessPerSecond(samples) {
  const seconds = Math.floor(samples.length / SAMPLE_RATE);
  const out = new Float32Array(seconds);
  for (let s = 0; s < seconds; s++) {
    let sum = 0;
    const from = s * SAMPLE_RATE;
    for (let i = from; i < from + SAMPLE_RATE; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / SAMPLE_RATE) / 32768;
    out[s] = 20 * Math.log10(rms + 1e-6); // -120 dB = silence
  }
  return out;
}

function movingAverage(arr, radius) {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(arr.length - 1, i + radius); j++) { sum += arr[j]; n++; }
    out[i] = sum / n;
  }
  return out;
}

function rollingMedian(arr, radius) {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const win = Array.from(arr.slice(Math.max(0, i - radius), Math.min(arr.length, i + radius + 1))).sort((a, b) => a - b);
    out[i] = win[win.length >> 1];
  }
  return out;
}

// Choisit les meilleurs moments sans que les clips se chevauchent
export function pickMoments(loudness, duration, count, length) {
  if (duration <= length) return [{ start: 0, length: duration, score: 1 }];

  const smooth = movingAverage(loudness, 1);                 // lisse sur ~3 s
  const baseline = rollingMedian(smooth, 30);                // le volume "normal" autour (±30 s)
  const sorted = Array.from(smooth).sort((a, b) => a - b);
  const globalMedian = sorted[sorted.length >> 1] ?? -60;

  // Un moment fort = nettement plus fort que d'habitude autour, et pas du silence
  const scores = Array.from(smooth, (v, i) => (v - baseline[i]) + 0.3 * (v - globalMedian));
  const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);

  const picked = [];
  for (const peak of order) {
    if (picked.length >= count) break;
    // On démarre un peu avant le pic : on voit ce qui amène le moment, puis la réaction
    const start = Math.min(Math.max(0, peak - Math.round(length * 0.6)), Math.max(0, duration - length));
    const overlaps = picked.some((p) => start < p.start + p.length && p.start < start + length);
    if (!overlaps) picked.push({ start, length, score: scores[peak] });
  }
  return picked;
}

// Sans son : on répartit les clips régulièrement dans la vidéo
function evenMoments(duration, count, length) {
  if (duration <= length) return [{ start: 0, length: duration, score: 0 }];
  const n = Math.min(count, Math.floor(duration / length));
  const gap = (duration - n * length) / (n + 1);
  return Array.from({ length: n }, (_, i) => ({ start: gap * (i + 1) + length * i, length, score: 0 }));
}

function verticalFilter(layout) {
  if (layout === 'blur') {
    // L'image entière au centre, posée sur une version agrandie et floutée d'elle-même
    return `split=2[bg][fg];` +
      `[bg]scale=${OUT_W / 2}:${OUT_H / 2}:force_original_aspect_ratio=increase,crop=${OUT_W / 2}:${OUT_H / 2},` +
      `boxblur=10:2,scale=${OUT_W}:${OUT_H},setsar=1[bg2];` +
      `[fg]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[fg2];` +
      `[bg2][fg2]overlay=(W-w)/2:(H-h)/2`;
  }
  // Plein écran : on agrandit puis on coupe ce qui dépasse sur les côtés
  return `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1`;
}

async function run() {
  if (!state.file || state.busy) return;
  if (state.clips.length && !confirm('Les clips actuels seront remplacés. Continuer ?')) return;

  clearGallery();
  hideError();
  state.busy = true;
  state.cancelled = false;
  logLines = [];
  setBusyUI(true);
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}

  const ext = (/\.([a-z0-9]+)$/i.exec(state.file.name) || [, 'mp4'])[1].toLowerCase();
  // Copie "légère" du fichier avec un nom simple (aucune donnée n'est dupliquée)
  const source = new File([state.file], `source.${ext}`, { type: state.file.type });
  const src = `/in/source.${ext}`;

  try {
    ffmpeg = await createEngine({ onStatus: setProgress, onLog });

    // La vidéo est lue directement depuis le téléphone, sans la charger en mémoire
    await ffmpeg.createDir('/in');
    await ffmpeg.mount('WORKERFS', { files: [source] }, '/in');

    // 1) Analyse du son
    setProgress(0, '🎧 Écoute de la vidéo pour trouver les moments forts…');
    onTime = (t) => state.duration && setProgress(t / state.duration,
      `🎧 Analyse du son… ${Math.min(99, Math.round((t / state.duration) * 100))} %`);
    const code = await ffmpeg.exec(['-i', src, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '/audio.raw']);
    if (state.cancelled) return;

    const { count, length, layout } = state.settings;
    let moments;
    let noSound = false;
    if (code === 0) {
      const raw = await ffmpeg.readFile('/audio.raw');
      await ffmpeg.deleteFile('/audio.raw');
      const samples = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.byteLength & ~1)));
      const loud = loudnessPerSecond(samples);
      const duration = state.duration || loud.length;
      moments = pickMoments(loud, duration, count, length);
    } else if (/does not contain any stream|matches no streams/i.test(logLines.join('\n'))) {
      noSound = true;
      moments = evenMoments(state.duration, count, length);
    } else {
      throw new Error("Impossible de lire cette vidéo. Elle est peut-être abîmée ou dans un format non pris en charge.");
    }
    if (!moments.length || !state.duration) throw new Error("Impossible de lire cette vidéo.");

    // 2) Création des clips, du meilleur au moins bon
    el.galleryCard.hidden = false;
    el.galleryInfo.textContent = noSound
      ? "Cette vidéo n'a pas de son : les clips sont répartis régulièrement."
      : moments.length > 1
        ? `${moments.length} moments forts trouvés. Les meilleurs sont en premier.`
        : 'Ta vidéo est courte : elle donne un seul clip.';

    const maxScore = Math.max(...moments.map((m) => m.score), 0.0001);
    const started = Date.now();
    for (let i = 0; i < moments.length; i++) {
      if (state.cancelled) return;
      const m = moments[i];
      const label = `✂️ Clip ${i + 1} sur ${moments.length}`;
      const elapsed = (Date.now() - started) / 1000;
      const eta = i ? ` · encore ~${minutes((elapsed / i) * (moments.length - i))}` : '';
      setProgress(i / moments.length, `${label}${eta}`);
      onTime = (t) => setProgress((i + Math.min(1, t / m.length)) / moments.length, `${label}${eta}`);

      const out = `/clip${i}.mp4`;
      const ret = await ffmpeg.exec([
        '-ss', m.start.toFixed(2), '-i', src, '-t', m.length.toFixed(2),
        '-vf', verticalFilter(layout),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-fpsmax', '30',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
      ]);
      if (state.cancelled) return;
      if (ret !== 0) continue; // on passe au clip suivant
      const data = await ffmpeg.readFile(out);
      await ffmpeg.deleteFile(out);
      addClip(new Blob([data.buffer], { type: 'video/mp4' }), m, i, m.score / maxScore, noSound);
    }

    if (!state.clips.length) throw new Error("Aucun clip n'a pu être créé avec cette vidéo.");
    setProgress(1, 'Terminé !');
  } catch (err) {
    if (state.cancelled) return;
    console.error(err, logLines.join('\n'));
    const msg = err && err.message;
    showError(msg && msg.length < 200 && !/^\w+Error/.test(msg)
      ? msg
      : "Quelque chose s'est mal passé. Essaie avec une vidéo plus courte.");
  } finally {
    onTime = null;
    if (ffmpeg) {
      try { await ffmpeg.unmount('/in'); } catch {}
      try { await ffmpeg.deleteDir('/in'); } catch {}
      ffmpeg.terminate(); // libère toute la mémoire utilisée
      ffmpeg = null;
    }
    state.busy = false;
    setBusyUI(false);
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }
}

function setBusyUI(busy) {
  el.progressWrap.hidden = !busy;
  el.runBtn.disabled = busy;
  el.fileInput.disabled = busy;
  el.runBtn.textContent = state.clips.length && !busy ? '🔁 Recommencer avec d\'autres réglages' : '✨ Trouver les meilleurs moments';
}

el.runBtn.addEventListener('click', run);
el.cancelBtn.addEventListener('click', () => {
  state.cancelled = true;
  if (ffmpeg) { ffmpeg.terminate(); ffmpeg = null; }
  showError(state.clips.length ? 'Arrêté. Tes clips déjà créés sont gardés ci-dessous.' : 'Arrêté.');
});

// ---------------------------------------------------------------------------
// Étape 4 : galerie pour trier, partager, télécharger
// ---------------------------------------------------------------------------
const CAN_SHARE_FILES = (() => {
  try {
    return !!navigator.canShare && navigator.canShare({ files: [new File([''], 't.mp4', { type: 'video/mp4' })] });
  } catch { return false; }
})();

function addClip(blob, moment, index, strength, noSound) {
  const url = URL.createObjectURL(blob);
  const stamp = clock(moment.start).replace(/:/g, 'm');
  const name = `clip-${String(index + 1).padStart(2, '0')}-${stamp}s.mp4`;

  const card = document.createElement('article');
  card.className = 'clip';

  const video = document.createElement('video');
  video.src = `${url}#t=0.1`; // affiche la première image comme aperçu
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';

  const flames = noSound ? '' : ` ${'🔥'.repeat(strength > 0.75 ? 3 : strength > 0.4 ? 2 : 1)}`;
  const info = document.createElement('p');
  info.className = 'clip-info';
  const title = Object.assign(document.createElement('strong'), { textContent: `n°${index + 1}${flames}` });
  const details = Object.assign(document.createElement('span'), {
    textContent: `${clock(moment.start)} → ${clock(moment.start + moment.length)} · ${formatSize(blob.size)}`,
  });
  info.append(title, details);

  const actions = document.createElement('div');
  actions.className = CAN_SHARE_FILES ? 'clip-actions with-share' : 'clip-actions';

  if (CAN_SHARE_FILES) {
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'btn-small primary';
    share.textContent = '📤 Partager';
    share.addEventListener('click', async () => {
      try {
        await navigator.share({ files: [new File([blob], name, { type: 'video/mp4' })] });
      } catch (e) {
        if (e.name !== 'AbortError') alert("Le partage n'a pas marché. Utilise plutôt « Télécharger ».");
      }
    });
    actions.appendChild(share);
  }

  const dl = document.createElement('a');
  dl.className = `btn-small${CAN_SHARE_FILES ? '' : ' primary'}`;
  dl.href = url;
  dl.download = name;
  dl.textContent = CAN_SHARE_FILES ? '⬇️' : '⬇️ Télécharger';
  dl.setAttribute('aria-label', 'Télécharger ce clip');
  actions.appendChild(dl);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn-small danger';
  del.textContent = '🗑️';
  del.setAttribute('aria-label', 'Supprimer ce clip');
  del.addEventListener('click', () => removeClip(url));
  actions.appendChild(del);

  card.append(video, info, actions);
  el.gallery.appendChild(card);
  state.clips.push({ url, name, card });
  updateCount();
}

function removeClip(url) {
  const i = state.clips.findIndex((c) => c.url === url);
  if (i < 0) return;
  state.clips[i].card.remove();
  URL.revokeObjectURL(url);
  state.clips.splice(i, 1);
  updateCount();
}

function clearGallery() {
  state.clips.forEach((c) => URL.revokeObjectURL(c.url));
  state.clips = [];
  el.gallery.replaceChildren();
  el.galleryCard.hidden = true;
}

function updateCount() {
  const n = state.clips.length;
  el.galleryCard.querySelector('h2').lastChild.textContent = ` Trie tes clips (${n})`;
  if (!CAN_SHARE_FILES) {
    el.shareTip.innerHTML = 'Garde les meilleurs, supprime les autres, puis <strong>télécharge</strong>-les pour les poster sur TikTok, Instagram…';
  }
}
