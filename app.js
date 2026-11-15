// Convertisseur audio / vidéo / GIF qui tourne entièrement dans le navigateur
// grâce à ffmpeg.wasm (FFmpeg compilé pour le web).

import { FFmpeg } from './lib/ffmpeg/index.js';
import { fetchFile, toBlobURL } from './lib/util/index.js';

// Le "moteur" FFmpeg (~30 Mo) est téléchargé une seule fois depuis un CDN.
const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';

// ---------------------------------------------------------------------------
// Les formats proposés et la commande FFmpeg utilisée pour chacun
// ---------------------------------------------------------------------------
const EVEN_SIZE = 'scale=trunc(iw/2)*2:trunc(ih/2)*2'; // H.264 exige une taille paire

const FORMATS = {
  // Vidéo
  mp4:  { group: 'video', label: 'MP4',  hint: 'le plus courant', mime: 'video/mp4',
          args: () => ['-vf', EVEN_SIZE, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                       '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'] },
  mov:  { group: 'video', label: 'MOV',  hint: 'iPhone / Mac', mime: 'video/quicktime',
          args: () => ['-vf', EVEN_SIZE, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                       '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k'] },
  webm: { group: 'video', label: 'WEBM', hint: 'pour le web', mime: 'video/webm',
          args: () => ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M',
                       '-c:a', 'libopus', '-b:a', '128k'] },
  // Audio
  mp3:  { group: 'audio', label: 'MP3',  hint: 'marche partout', mime: 'audio/mpeg',
          args: () => ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'] },
  wav:  { group: 'audio', label: 'WAV',  hint: 'qualité max', mime: 'audio/wav',
          args: () => ['-vn', '-c:a', 'pcm_s16le'] },
  m4a:  { group: 'audio', label: 'M4A',  hint: 'Apple', mime: 'audio/mp4',
          args: () => ['-vn', '-c:a', 'aac', '-b:a', '192k'] },
  // Animation
  gif:  { group: 'gif',   label: 'GIF',  hint: 'animation', mime: 'image/gif',
          args: ({ start, duration, width }) => [
            '-ss', String(start), '-t', String(duration),
            '-vf', `fps=12,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
            '-loop', '0'] },
};

const VIDEO_EXT = ['mp4', 'mov', 'webm', 'gif', 'mkv', 'avi', 'm4v', '3gp'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'];
const BIG_FILE = 300 * 1024 * 1024; // au-delà, un téléphone peut manquer de mémoire

// ---------------------------------------------------------------------------
// Éléments de la page
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  fileInput: $('fileInput'), dropzone: $('dropzone'), dzText: $('dzText'), fileInfo: $('fileInfo'),
  formatCard: $('formatCard'), convertCard: $('convertCard'), resultCard: $('resultCard'),
  videoGroup: $('videoGroup'), audioGroup: $('audioGroup'), gifGroup: $('gifGroup'),
  videoFormats: $('videoFormats'), audioFormats: $('audioFormats'), gifFormats: $('gifFormats'),
  gifOptions: $('gifOptions'), gifStart: $('gifStart'), gifDuration: $('gifDuration'), gifWidth: $('gifWidth'),
  startLabel: $('startLabel'), durLabel: $('durLabel'),
  convertBtn: $('convertBtn'), cancelBtn: $('cancelBtn'), progressWrap: $('progressWrap'),
  progressBar: $('progressBar'), statusText: $('statusText'), errorText: $('errorText'),
  preview: $('preview'), resultInfo: $('resultInfo'), downloadBtn: $('downloadBtn'), againBtn: $('againBtn'),
};

const state = {
  file: null,
  kind: null,        // 'video' ou 'audio'
  ext: '',
  mediaDuration: 0,  // durée du fichier en secondes (si connue)
  target: null,      // format choisi
  resultURL: null,
  busy: false,
};

let ffmpeg = null;
let coreURLs = null;     // gardés en mémoire pour ne pas re-télécharger le moteur
let totalSeconds = 0;    // durée à traiter, pour la barre de progression
let logLines = [];      // messages de FFmpeg pendant la conversion en cours

// ---------------------------------------------------------------------------
// Petites aides
// ---------------------------------------------------------------------------
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m} min ${String(s).padStart(2, '0')} s` : `${s} s`;
}

function getExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '') || 'fichier';
}

function setProgress(ratio, text) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  el.progressBar.style.width = `${pct}%`;
  if (text) el.statusText.textContent = text;
}

function showError(msg) {
  el.errorText.textContent = msg;
  el.errorText.hidden = false;
}

function hideError() {
  el.errorText.hidden = true;
}

// Lit la durée du fichier avec le lecteur du navigateur (peut échouer : pas grave)
function readDuration(file) {
  return new Promise((resolve) => {
    const tag = file.type.startsWith('audio') ? 'audio' : 'video';
    const media = document.createElement(tag);
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 0); };
    media.preload = 'metadata';
    media.onloadedmetadata = () => done(media.duration);
    media.onerror = () => done(0);
    setTimeout(() => done(0), 4000);
    media.src = url;
  });
}

// ---------------------------------------------------------------------------
// Étape 1 : choix du fichier
// ---------------------------------------------------------------------------
async function handleFile(file) {
  if (!file || state.busy) return;
  hideError();
  resetResult();

  const ext = getExt(file.name);
  let kind = null;
  if (file.type.startsWith('video/') || file.type === 'image/gif' || VIDEO_EXT.includes(ext)) kind = 'video';
  else if (file.type.startsWith('audio/') || AUDIO_EXT.includes(ext)) kind = 'audio';

  if (!kind) {
    el.formatCard.hidden = true;
    el.convertCard.hidden = false;
    showError("Ce fichier n'est ni un son ni une vidéo. Choisis plutôt un fichier MP3, MP4, MOV, WAV, GIF…");
    return;
  }

  state.file = file;
  state.kind = kind;
  state.ext = ext;
  state.target = null;

  el.dzText.textContent = file.name;
  el.fileInfo.hidden = false;
  el.fileInfo.textContent = `${kind === 'video' ? '🎬 Vidéo' : '🎵 Audio'} · ${formatSize(file.size)}`;
  if (file.size > BIG_FILE) {
    el.fileInfo.textContent += ' · ⚠️ Fichier très lourd : la conversion peut échouer sur téléphone.';
  }

  state.mediaDuration = await readDuration(file);
  if (state.mediaDuration) {
    el.fileInfo.textContent += ` · ${formatTime(state.mediaDuration)}`;
    el.gifStart.max = Math.max(0, Math.floor(state.mediaDuration - 1));
  } else {
    el.gifStart.max = 60;
  }
  el.gifStart.value = 0;
  updateGifLabels();

  renderFormats();
  el.formatCard.hidden = false;
  el.convertCard.hidden = false;
  el.convertBtn.disabled = true;
  el.convertBtn.textContent = 'Convertir';
}

el.fileInput.addEventListener('change', () => handleFile(el.fileInput.files[0]));

// Glisser-déposer (pratique sur ordinateur)
['dragenter', 'dragover'].forEach((t) => el.dropzone.addEventListener(t, (e) => {
  e.preventDefault(); el.dropzone.classList.add('drag');
}));
['dragleave', 'drop'].forEach((t) => el.dropzone.addEventListener(t, (e) => {
  e.preventDefault(); el.dropzone.classList.remove('drag');
}));
el.dropzone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

// ---------------------------------------------------------------------------
// Étape 2 : choix du format
// ---------------------------------------------------------------------------
function renderFormats() {
  const containers = { video: el.videoFormats, audio: el.audioFormats, gif: el.gifFormats };
  Object.values(containers).forEach((c) => { c.innerHTML = ''; });

  for (const [key, f] of Object.entries(FORMATS)) {
    // Un fichier audio ne peut pas devenir une vidéo ou un GIF (il n'y a pas d'image)
    if (state.kind === 'audio' && f.group !== 'audio') continue;
    // Inutile de proposer le même format que celui d'origine
    if (key === state.ext) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'format-btn';
    btn.dataset.format = key;
    btn.innerHTML = `${f.label}<small>${f.hint}</small>`;
    btn.addEventListener('click', () => selectFormat(key));
    containers[f.group].appendChild(btn);
  }

  el.videoGroup.hidden = !el.videoFormats.children.length;
  el.audioGroup.hidden = !el.audioFormats.children.length;
  el.gifGroup.hidden = !el.gifFormats.children.length;
  el.gifOptions.hidden = true;
}

function selectFormat(key) {
  if (state.busy) return;
  state.target = key;
  document.querySelectorAll('.format-btn').forEach((b) => {
    b.classList.toggle('selected', b.dataset.format === key);
  });
  el.gifOptions.hidden = key !== 'gif';
  el.convertBtn.disabled = false;
  el.convertBtn.textContent = `Convertir en ${FORMATS[key].label}`;
  hideError();
}

function updateGifLabels() {
  el.startLabel.textContent = `${el.gifStart.value} s`;
  el.durLabel.textContent = `${el.gifDuration.value} s`;
}
el.gifStart.addEventListener('input', updateGifLabels);
el.gifDuration.addEventListener('input', updateGifLabels);

// ---------------------------------------------------------------------------
// Étape 3 : conversion
// ---------------------------------------------------------------------------
async function loadEngine() {
  if (ffmpeg) return;

  if (!coreURLs) {
    setProgress(0, 'Téléchargement du moteur de conversion… (une seule fois)');
    const coreURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript');
    const wasmURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm', true,
      ({ received, total }) => {
        if (total > 0) {
          setProgress(received / total,
            `Téléchargement du moteur… ${formatSize(received)} / ${formatSize(total)}`);
        }
      });
    coreURLs = { coreURL, wasmURL };
  }

  setProgress(0, 'Démarrage du moteur…');
  const instance = new FFmpeg();
  instance.on('log', ({ message }) => onLog(message));
  await instance.load(coreURLs);
  ffmpeg = instance;
}

// FFmpeg écrit des lignes comme "Duration: 00:01:02.50" puis "time=00:00:12.30".
// On s'en sert pour faire avancer la barre de progression.
function parseClock(str) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(str);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
}

function onLog(message) {
  logLines.push(message);
  if (logLines.length > 400) logLines.shift();
  if (!totalSeconds) {
    const d = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(message);
    if (d) totalSeconds = parseClock(d[1]);
  }
  const t = /time=\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(message);
  if (t && totalSeconds > 0) {
    const ratio = parseClock(t[1]) / totalSeconds;
    setProgress(ratio, `Conversion en cours… ${Math.min(99, Math.round(ratio * 100))} %`);
  }
}

async function convert() {
  if (!state.file || !state.target || state.busy) return;
  const target = state.target;
  const format = FORMATS[target];

  state.busy = true;
  hideError();
  resetResult();
  el.convertBtn.disabled = true;
  el.progressWrap.hidden = false;
  document.querySelectorAll('.format-btn, #fileInput').forEach((b) => { b.disabled = true; });

  logLines = [];
  const inputName = `input.${state.ext || 'bin'}`;
  const outputName = `output.${target}`;

  try {
    await loadEngine();

    setProgress(0, 'Préparation du fichier…');
    await ffmpeg.writeFile(inputName, await fetchFile(state.file));

    let options = {};
    if (target === 'gif') {
      options = {
        start: Number(el.gifStart.value),
        duration: Number(el.gifDuration.value),
        width: Number(el.gifWidth.value),
      };
      totalSeconds = options.duration;
    } else {
      totalSeconds = state.mediaDuration; // sinon on le lira dans les logs de FFmpeg
    }

    // Pour le GIF, "-ss" avant "-i" permet de sauter directement au bon moment
    const args = target === 'gif'
      ? [...format.args(options).slice(0, 4), '-i', inputName, ...format.args(options).slice(4), outputName]
      : ['-i', inputName, ...format.args(options), outputName];

    setProgress(0, 'Conversion en cours…');
    const code = await ffmpeg.exec(args);
    if (code !== 0) throw new Error(explainFailure(target));

    const data = await ffmpeg.readFile(outputName);
    if (!data || !data.length) throw new Error(explainFailure(target));

    showResult(new Blob([data.buffer], { type: format.mime }), target);
    setProgress(1, 'Terminé !');
  } catch (err) {
    if (err && err.message === 'called FFmpeg.terminate()') return; // annulé par l'utilisateur
    console.error(err, logLines.join('\n'));
    showError(err && err.message && !/^\w+Error/.test(err.message) && err.message.length < 300
      ? err.message
      : "La conversion a échoué. Essaie avec un fichier plus petit ou un autre format.");
  } finally {
    // On libère la mémoire du moteur
    if (ffmpeg) {
      try { await ffmpeg.deleteFile(inputName); } catch {}
      try { await ffmpeg.deleteFile(outputName); } catch {}
    }
    finishBusy();
  }
}

function explainFailure(target) {
  const log = logLines.join('\n').toLowerCase();
  if (FORMATS[target].group === 'audio' && /does not contain any stream|matches no streams/.test(log)) {
    return "Cette vidéo n'a pas de son : impossible d'en faire un fichier audio.";
  }
  if (/invalid data|could not find codec|unknown format/.test(log)) {
    return "Ce fichier est abîmé ou dans un format que le convertisseur ne sait pas lire.";
  }
  if (/out of memory|cannot enlarge memory|oom/.test(log)) {
    return "Pas assez de mémoire sur l'appareil. Essaie avec un fichier plus petit.";
  }
  return "La conversion a échoué. Essaie avec un autre format ou un autre fichier.";
}

function finishBusy() {
  state.busy = false;
  el.progressWrap.hidden = true;
  el.convertBtn.disabled = !state.target;
  document.querySelectorAll('.format-btn, #fileInput').forEach((b) => { b.disabled = false; });
}

el.convertBtn.addEventListener('click', convert);

el.cancelBtn.addEventListener('click', () => {
  if (!ffmpeg) return;
  ffmpeg.terminate();  // arrête tout de suite ; le moteur sera relancé à la prochaine conversion
  ffmpeg = null;
  showError('Conversion annulée.');
});

// ---------------------------------------------------------------------------
// Résultat
// ---------------------------------------------------------------------------
function showResult(blob, target) {
  const url = URL.createObjectURL(blob);
  state.resultURL = url;
  const name = `${baseName(state.file.name)}.${target}`;

  const group = FORMATS[target].group;
  let media;
  if (group === 'gif') {
    media = document.createElement('img');
    media.alt = 'Aperçu du GIF';
  } else {
    media = document.createElement(group === 'audio' ? 'audio' : 'video');
    media.controls = true;
    media.playsInline = true;
  }
  media.src = url;
  el.preview.replaceChildren(media);

  el.resultInfo.textContent = `${name} · ${formatSize(blob.size)}`;
  el.downloadBtn.href = url;
  el.downloadBtn.download = name;
  el.resultCard.hidden = false;
  el.resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetResult() {
  if (state.resultURL) URL.revokeObjectURL(state.resultURL);
  state.resultURL = null;
  el.preview.replaceChildren();
  el.resultCard.hidden = true;
}

el.againBtn.addEventListener('click', () => {
  resetResult();
  state.file = null;
  state.target = null;
  el.fileInput.value = '';
  el.dzText.textContent = 'Touche ici pour choisir un fichier';
  el.fileInfo.hidden = true;
  el.formatCard.hidden = true;
  el.convertCard.hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
