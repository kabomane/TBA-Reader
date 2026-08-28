import { BlobWriter, ZipWriter } from "@zip.js/zip.js";
import { getEpisodesSnapshot, getPublicStorageUrl } from "./supabase.js";

const MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function slugify(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54) || "episode";
}

function episodeNumber(value) {
  return String(Number(value) || value || 0).padStart(3, "0");
}

function extensionFor(item, fallback) {
  const keyExtension = item?.key?.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  if (keyExtension) return keyExtension === "jpeg" ? "jpg" : keyExtension;
  const mime = String(item?.mime || "").split(";")[0].toLowerCase();
  return MIME_EXTENSIONS[mime] || fallback;
}

function archiveFilename() {
  return `tba-reader-archive-${new Date().toISOString().slice(0, 10)}.zip`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function addRemoteEntry(zipWriter, path, episode, item, level) {
  if (!item?.key) throw new Error("référence absente");
  const url = getPublicStorageUrl(episode.storageProvider, item.key);
  if (!url) throw new Error("URL publique indisponible");
  const response = await fetch(url, { method: "GET", cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error("flux de téléchargement indisponible");
  await zipWriter.add(path, response.body, { level });
}

function episodeExport(episode, files) {
  return {
    schemaVersion: 1,
    id: episode.uid,
    shareId: episode.id,
    number: episode.number,
    title: episode.title,
    description: episode.description,
    type: episode.type,
    tags: episode.tags ?? [],
    publishedOn: episode.date,
    duration: episode.duration,
    createdAt: episode.createdAt,
    visibility: episode.token ? "restricted" : "public",
    youtubeUrl: episode.youtube || null,
    storage: {
      provider: episode.storageProvider,
      bytes: Number(episode.storageBytes || 0),
      files,
    },
  };
}

function buildIndex(entries, errors) {
  const cards = entries.map(({ episode, folder, files, missing }) => {
    const search = [episode.number, episode.title, episode.description, episode.type, ...(episode.tags ?? [])].join(" ").toLowerCase();
    const image = files.image ? `<img src="${escapeHtml(`${folder}/${files.image}`)}" alt="" loading="lazy">` : "";
    const audio = files.audio ? `<audio controls preload="none" src="${escapeHtml(`${folder}/${files.audio}`)}"></audio>` : "";
    const body = files.body ? `<a href="${escapeHtml(`${folder}/${files.body}`)}">Lire le contenu Markdown</a>` : "";
    const youtube = episode.youtube ? `<a href="${escapeHtml(episode.youtube)}" target="_blank" rel="noreferrer">Voir sur YouTube</a>` : "";
    const warning = missing.length ? `<p class="warning">Fichiers manquants : ${escapeHtml(missing.join(", "))}</p>` : "";
    return `<article data-search="${escapeHtml(search)}">
      ${image}
      <div class="content">
        <p class="meta">TBA — ${escapeHtml(episodeNumber(episode.number))} · ${escapeHtml(episode.type)} · ${escapeHtml(episode.storageProvider === "r2" ? "Cloudflare R2" : "Supabase")}</p>
        <h2>${escapeHtml(episode.title)}</h2>
        <p>${escapeHtml(episode.description)}</p>
        ${audio}
        <nav>${body}${youtube}<a href="${escapeHtml(`${folder}/episode.json`)}">Métadonnées JSON</a></nav>
        ${warning}
      </div>
    </article>`;
  }).join("\n");

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Archive TBA Reader</title>
  <style>
    :root{color-scheme:dark;--bg:#0b0b0d;--surface:#131316;--line:#2d2d32;--text:#f1eee7;--muted:#aaa69e;--accent:#dcae59;--danger:#e09283}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,sans-serif}main{width:min(980px,calc(100% - 32px));margin:0 auto;padding:50px 0}header{margin-bottom:28px}h1,h2{font-family:Georgia,serif}h1{margin:0 0 8px;font-size:clamp(32px,7vw,58px)}header p,.meta{color:var(--muted)}input{width:100%;margin:20px 0 8px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:#0e0e11;color:var(--text);font:inherit}section{display:grid;gap:14px}article{overflow:hidden;display:grid;grid-template-columns:minmax(150px,220px) 1fr;border:1px solid var(--line);border-radius:18px;background:var(--surface)}article>img{width:100%;height:100%;min-height:190px;object-fit:cover}.content{padding:22px}.meta{margin:0;font-size:11px;text-transform:uppercase}.content h2{margin:5px 0 8px;font-size:25px}.content>p:not(.meta){margin:0 0 14px;color:#cbc7bf}audio{width:100%;margin:5px 0 12px}nav{display:flex;flex-wrap:wrap;gap:8px 16px}a{color:var(--accent);text-underline-offset:3px}.warning{color:var(--danger)!important;font-size:12px}.archive-warning{color:var(--danger)}[hidden]{display:none}@media(max-width:620px){main{padding:28px 0}article{grid-template-columns:1fr}article>img{max-height:260px}.content{padding:18px}}
  </style>
</head>
<body><main>
  <header><h1>Archive TBA Reader</h1><p>${entries.length} épisode${entries.length > 1 ? "s" : ""} · créée le ${escapeHtml(new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date()))}</p>${errors.length ? `<p class="archive-warning">${errors.length} fichier${errors.length > 1 ? "s" : ""} n’a pas pu être ajouté. Consultez erreurs.txt.</p>` : ""}</header>
  <label for="search">Rechercher dans l’archive</label><input id="search" type="search" placeholder="Titre, numéro, type ou tag…">
  <section id="episodes">${cards}</section>
</main><script>document.getElementById("search").addEventListener("input",function(){const q=this.value.trim().toLowerCase();document.querySelectorAll("[data-search]").forEach(function(card){card.hidden=!card.dataset.search.includes(q)})});</script></body>
</html>`;
}

async function chooseDirectSave(filename) {
  if (typeof window.showSaveFilePicker !== "function") return null;
  return window.showSaveFilePicker({
    suggestedName: filename,
    types: [{ description: "Archive ZIP", accept: { "application/zip": [".zip"] } }],
  });
}

export async function downloadEpisodeArchive({ episodeIds = null, onProgress = () => {} } = {}) {
  const filename = archiveFilename();
  const fileHandle = await chooseDirectSave(filename);
  onProgress({ phase: "loading", current: 0, total: 0, label: "Lecture des épisodes" });
  const episodes = await getEpisodesSnapshot();
  const selectedIds = Array.isArray(episodeIds) ? new Set(episodeIds.map(String)) : null;
  const sortedEpisodes = episodes
    .filter((episode) => !selectedIds || selectedIds.has(episode.uid))
    .sort((a, b) => Number(a.number) - Number(b.number));
  if (!sortedEpisodes.length) throw new Error("Aucun épisode sélectionné n’existe encore.");
  const blobWriter = fileHandle ? null : new BlobWriter("application/zip");
  const output = fileHandle ? await fileHandle.createWritable() : blobWriter;
  const zipWriter = new ZipWriter(output, { useWebWorkers: false });
  const entries = [];
  const errors = [];
  const episodeErrors = [];
  const completeEpisodeIds = [];
  const incompleteEpisodeIds = [];

  for (let index = 0; index < sortedEpisodes.length; index += 1) {
    const episode = sortedEpisodes[index];
    const folder = `episodes/${episodeNumber(episode.number)}-${slugify(episode.title)}`;
    const files = { body: null, image: null, audio: null };
    const missing = [];
    onProgress({ phase: "files", current: index + 1, total: sortedEpisodes.length, label: episode.title });

    const candidates = [
      { kind: "body", item: episode.storageData?.body, filename: "body.md", level: 6 },
      { kind: "image", item: episode.storageData?.image, filename: `image.${extensionFor(episode.storageData?.image, "bin")}`, level: 0 },
      { kind: "audio", item: episode.storageData?.audio, filename: `audio.${extensionFor(episode.storageData?.audio, "bin")}`, level: 0 },
    ];

    for (const candidate of candidates) {
      if (!candidate.item) continue;
      try {
        await addRemoteEntry(zipWriter, `${folder}/${candidate.filename}`, episode, candidate.item, candidate.level);
        files[candidate.kind] = candidate.filename;
      } catch (error) {
        missing.push(candidate.kind);
        const message = error?.message || "échec inconnu";
        errors.push(`TBA ${episodeNumber(episode.number)} — ${episode.title} · ${candidate.kind} : ${message}`);
        episodeErrors.push({ episodeId: episode.uid, kind: candidate.kind, message });
      }
    }

    await zipWriter.add(`${folder}/episode.json`, new Blob([JSON.stringify(episodeExport(episode, files), null, 2)], { type: "application/json" }).stream(), { level: 6 });
    entries.push({ episode, folder, files, missing });
    if (missing.length) incompleteEpisodeIds.push(episode.uid);
    else completeEpisodeIds.push(episode.uid);
  }

  onProgress({ phase: "index", current: sortedEpisodes.length, total: sortedEpisodes.length, label: "Création de l’index" });
  await zipWriter.add("index.html", new Blob([buildIndex(entries, errors)], { type: "text/html;charset=utf-8" }).stream(), { level: 6 });
  if (errors.length) {
    await zipWriter.add("erreurs.txt", new Blob([`${errors.join("\n")}\n`], { type: "text/plain;charset=utf-8" }).stream(), { level: 6 });
  }
  const result = await zipWriter.close();
  if (!fileHandle) downloadBlob(result, filename);
  onProgress({ phase: "done", current: sortedEpisodes.length, total: sortedEpisodes.length, label: "Archive prête" });
  return {
    filename,
    episodes: sortedEpisodes.length,
    errors,
    episodeErrors,
    completeEpisodeIds,
    incompleteEpisodeIds,
    directSave: Boolean(fileHandle),
  };
}
