# 🎬 Convertisseur Mp3 Mp4

Une page web pour convertir des fichiers audio et vidéo, et créer des GIF.
Tout se passe **dans ton navigateur** : tes fichiers ne sont envoyés nulle part.

## Formats

| Type | Formats |
|---|---|
| 🎬 Vidéo | MP4, MOV, WEBM |
| 🎵 Audio | MP3, WAV, M4A |
| 🖼️ Animation | GIF (avec choix du début, de la durée et de la taille) |

Exemples : MP4 ➜ MP3 (garder seulement le son), MOV ➜ MP4, vidéo ➜ GIF, WAV ➜ MP3…

## Comment l'utiliser

1. Ouvre la page.
2. Choisis ton fichier.
3. Choisis le format voulu.
4. Appuie sur **Convertir**, puis sur **Télécharger**.

La première conversion télécharge le moteur de conversion (~30 Mo). Ensuite, c'est plus rapide.

## Comment ça marche (pour les curieux)

| Fichier | Rôle |
|---|---|
| `index.html` | La structure de la page (les boutons, les zones de texte…) |
| `style.css` | L'apparence (couleurs, tailles, mode sombre…) |
| `app.js` | Le cerveau : il lit ton fichier et lance la conversion |
| `lib/` | Les outils qui permettent d'utiliser FFmpeg dans le navigateur |

La conversion est faite par [FFmpeg](https://ffmpeg.org), via [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm).

## Limites

- Les très gros fichiers (plus de ~300 Mo) peuvent échouer sur téléphone, faute de mémoire.
- Les conversions vidéo sont plus lentes que sur un logiciel installé sur ordinateur.
