// Moteur FFmpeg partagé : téléchargement (une seule fois) et démarrage.

import { FFmpeg } from './lib/ffmpeg/index.js';

const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
const WASM_SIZE = 32129114; // taille réelle du moteur, utile si le serveur ne l'indique pas

let coreURLs = null; // gardés en mémoire pour ne pas re-télécharger le moteur

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
}

// Télécharge un fichier en suivant la progression, et le garde en mémoire (adresse "blob:")
async function downloadAsBlobURL(url, mime, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Impossible de télécharger le moteur de conversion. Vérifie ta connexion Internet.');
  const chunks = [];
  if (res.body && onProgress) {
    // Le serveur peut compresser le fichier : sa taille annoncée n'est alors pas fiable
    const announced = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received, Math.max(received, announced >= WASM_SIZE ? announced : WASM_SIZE));
    }
  } else {
    chunks.push(await res.arrayBuffer());
  }
  return URL.createObjectURL(new Blob(chunks, { type: mime }));
}

// Crée un moteur FFmpeg prêt à l'emploi.
// onStatus(ratio, texte) affiche la progression, onLog(message) reçoit les messages de FFmpeg.
export async function createEngine({ onStatus = () => {}, onLog = () => {} } = {}) {
  if (!coreURLs) {
    onStatus(0, 'Téléchargement du moteur… (une seule fois)');
    const coreURL = await downloadAsBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript');
    const wasmURL = await downloadAsBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm',
      (received, total) => onStatus(received / total,
        `Téléchargement du moteur… ${formatSize(received)} / ${formatSize(total)}`));
    coreURLs = { coreURL, wasmURL };
  }
  onStatus(0, 'Démarrage du moteur…');
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => onLog(message));
  await ffmpeg.load(coreURLs);
  return ffmpeg;
}
