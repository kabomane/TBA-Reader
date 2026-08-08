import { AwsClient } from "aws4fetch";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://lfgllmxdcnylabdcvmsk.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_YAuJXFnXZDQBWjvKjJ2-0A_lTOKdpYm";
const MEDIA_BUCKET = "tba-media";
const MAX_SUPABASE_FILE_BYTES = 50_000_000;
const EPISODE_REQUEST_TIMEOUT = 8000;
const EPISODE_RETRY_DELAY = 1200;
const EPISODE_RECOVERY_DELAY = 15000;
const EPISODE_BODY_CACHE_PREFIX = "tba-episode-body-v1:";
export const EPISODE_REFRESH_INTERVAL_MS = 2 * 60 * 1000;

const EPISODE_COLUMNS = [
  "id", "share_id", "number", "title", "type", "tags", "published_on", "duration",
  "description", "palette", "token", "created_at",
  "storage_provider", "storage_bytes", "data",
].join(",");

const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
let publicStorageConfig = { r2Ready: false, r2PublicUrl: "" };

function getClient() {
  return client;
}

function encodeObjectKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function publicMediaUrl(provider, key) {
  if (!key) return "";
  if (provider === "r2" && publicStorageConfig.r2PublicUrl) {
    return `${publicStorageConfig.r2PublicUrl}/${encodeObjectKey(key)}`;
  }
  return getClient().storage.from(MEDIA_BUCKET).getPublicUrl(key).data.publicUrl;
}

function episodeBodyPath(episodeId) {
  return `episodes/${episodeId}/body.md`;
}

function normalizeRowData(row) {
  const stored = row.data && typeof row.data === "object" ? row.data : {};
  return {
    youtube: stored.youtube ?? "",
    body: stored.body ?? { key: episodeBodyPath(row.id), size: 0, mime: "text/markdown" },
    image: stored.image ?? null,
    audio: stored.audio ?? null,
  };
}

function fromRow(row) {
  const provider = row.storage_provider === "r2" ? "r2" : "supabase";
  const storageData = normalizeRowData(row);
  const imagePath = storageData.image?.key ?? "";
  const audioPath = storageData.audio?.key ?? "";
  return {
    uid: row.id,
    id: row.share_id,
    number: row.number,
    legacyId: /^\d+$/.test(row.id) ? row.id : "",
    title: row.title,
    type: row.type,
    tags: row.tags ?? [],
    date: row.published_on,
    duration: row.duration,
    description: row.description,
    body: typeof row.body === "string" ? row.body : "",
    bodyLoaded: typeof row.body === "string",
    youtube: storageData.youtube ?? "",
    image: publicMediaUrl(provider, imagePath),
    imagePath,
    audio: publicMediaUrl(provider, audioPath),
    audioPath,
    palette: row.palette ?? 0,
    token: row.token ?? "",
    createdAt: row.created_at,
    storageProvider: provider,
    storageBytes: Number(row.storage_bytes ?? 0),
    storageData,
  };
}

function toRow(episode, provider, data) {
  return {
    id: episode.uid,
    share_id: episode.id,
    number: episode.number,
    title: episode.title,
    type: episode.type,
    tags: episode.tags,
    published_on: episode.date,
    duration: episode.duration,
    description: episode.description,
    palette: episode.palette ?? 0,
    token: episode.token || null,
    created_at: episode.createdAt,
    storage_provider: provider,
    storage_bytes: [data.body, data.image, data.audio].filter(Boolean).reduce((sum, item) => sum + Number(item.size || 0), 0),
    data,
  };
}

async function fetchEpisodes() {
  const [episodesResult, configResult] = await Promise.all([
    getClient().from("episodes").select(EPISODE_COLUMNS).order("created_at", { ascending: false }),
    getClient().rpc("tba_public_storage_config"),
  ]);
  if (episodesResult.error) throw episodesResult.error;
  if (!configResult.error && configResult.data) publicStorageConfig = configResult.data;
  return episodesResult.data.map(fromRow);
}

function readEpisodeBodyCache(episodeId) {
  try {
    const saved = JSON.parse(localStorage.getItem(`${EPISODE_BODY_CACHE_PREFIX}${episodeId}`));
    if (!saved || saved.version !== 1 || typeof saved.body !== "string"
      || !Number.isFinite(saved.savedAt) || Date.now() - saved.savedAt >= EPISODE_REFRESH_INTERVAL_MS) return null;
    return saved.body;
  } catch {
    return null;
  }
}

function writeEpisodeBodyCache(episodeId, body) {
  try {
    localStorage.setItem(`${EPISODE_BODY_CACHE_PREFIX}${episodeId}`, JSON.stringify({ version: 1, savedAt: Date.now(), body }));
  } catch {
    // Cache facultatif.
  }
}

function removeEpisodeBodyCache(episodeId) {
  try {
    localStorage.removeItem(`${EPISODE_BODY_CACHE_PREFIX}${episodeId}`);
  } catch {
    // Suppression distante prioritaire.
  }
}

async function fetchEpisodeBody(episode) {
  const cached = readEpisodeBodyCache(episode.uid);
  if (cached !== null) return cached;
  const path = episode.storageData?.body?.key || episodeBodyPath(episode.uid);
  const response = await fetch(publicMediaUrl(episode.storageProvider, path));
  if (!response.ok) throw new Error("Contenu de l’épisode indisponible.");
  const body = await response.text();
  writeEpisodeBodyCache(episode.uid, body);
  return body;
}

export async function loadEpisodeDetails(episode) {
  if (!episode) throw new Error("Épisode introuvable.");
  if (episode.bodyLoaded) return episode;
  const body = await fetchEpisodeBody(episode);
  return { ...episode, body, bodyLoaded: true };
}

export function watchEpisodes(onEpisodes, onError, { initialDelay = 0 } = {}) {
  let active = true;
  let inFlight = null;
  let refreshTimer = null;
  let nextRefreshAt = 0;
  const delay = (duration) => new Promise((resolve) => window.setTimeout(resolve, duration));
  const fetchWithTimeout = async () => {
    let timeoutId;
    try {
      return await Promise.race([
        fetchEpisodes(),
        new Promise((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error("Délai de réponse Supabase dépassé.")), EPISODE_REQUEST_TIMEOUT);
        }),
      ]);
    } finally {
      window.clearTimeout(timeoutId);
    }
  };
  const scheduleRefresh = (duration = EPISODE_REFRESH_INTERVAL_MS) => {
    window.clearTimeout(refreshTimer);
    nextRefreshAt = Date.now() + duration;
    refreshTimer = window.setTimeout(() => {
      if (document.visibilityState === "visible") refresh();
    }, duration);
  };
  const refresh = () => {
    if (!active) return Promise.resolve();
    if (inFlight) return inFlight;
    window.clearTimeout(refreshTimer);
    nextRefreshAt = 0;
    let nextDelay = EPISODE_REFRESH_INTERVAL_MS;
    inFlight = (async () => {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const episodes = await fetchWithTimeout();
          if (active) onEpisodes(episodes);
          return;
        } catch (error) {
          lastError = error;
          if (attempt === 0 && active) await delay(EPISODE_RETRY_DELAY);
          if (!active) return;
        }
      }
      if (active) {
        onError(lastError);
        nextDelay = EPISODE_RECOVERY_DELAY;
      }
    })().finally(() => {
      inFlight = null;
      if (active) scheduleRefresh(nextDelay);
    });
    return inFlight;
  };
  const refreshWhenVisible = () => {
    if (document.visibilityState === "visible" && nextRefreshAt && Date.now() >= nextRefreshAt) refresh();
  };
  window.addEventListener("online", refresh);
  document.addEventListener("visibilitychange", refreshWhenVisible);
  if (initialDelay > 0) scheduleRefresh(initialDelay);
  else refresh();
  return {
    refresh,
    unsubscribe() {
      active = false;
      window.clearTimeout(refreshTimer);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    },
  };
}

function safeFilename(filename) {
  return filename.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-140);
}

async function adminRequest(pin, payload) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/tba-admin`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json", "x-tba-pin": pin },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Action créateur refusée.");
  return data;
}

export async function verifyAdminPin(pin) {
  await adminRequest(pin, { action: "verify" });
}

async function uploadSupabaseFile(episodeId, kind, file, pin) {
  const signed = await adminRequest(pin, { action: "sign-upload", episodeId, kind, filename: safeFilename(file.name) });
  const { error } = await getClient().storage.from(MEDIA_BUCKET).uploadToSignedUrl(signed.path, signed.token, file, {
    cacheControl: "3600",
    contentType: file.type || undefined,
  });
  if (error) throw error;
  return { key: signed.path, size: file.size, mime: file.type || "application/octet-stream", etag: null };
}

function mediaKey(episodeId, kind, filename) {
  return kind === "body"
    ? episodeBodyPath(episodeId)
    : `episodes/${episodeId}/${kind}-${Date.now()}-${safeFilename(filename)}`;
}

async function fetchBlob(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} source indisponible.`);
  return response.blob();
}

function r2Client(credentials) {
  return new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    region: "auto",
    service: "s3",
  });
}

async function uploadR2Items(episodeId, items, pin) {
  if (!items.length) return [];
  const credentials = await adminRequest(pin, {
    action: "r2-credentials",
    episodeId,
    objects: items.map((item) => item.key),
  });
  const signer = r2Client(credentials);
  const uploaded = [];
  for (const item of items) {
    const url = `https://${credentials.accountId}.r2.cloudflarestorage.com/${credentials.bucket}/${encodeObjectKey(item.key)}`;
    const response = await signer.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": item.blob.type || item.mime || "application/octet-stream" },
      body: item.blob,
    });
    if (!response.ok) throw new Error(`Envoi R2 refusé pour ${item.key}.`);
    uploaded.push({
      key: item.key,
      size: item.blob.size,
      mime: item.blob.type || item.mime || "application/octet-stream",
      etag: response.headers.get("etag"),
    });
  }
  return uploaded;
}

async function buildR2Data(episode, files, pin) {
  const switching = episode.storageProvider !== "r2";
  const bodyBlob = new Blob([episode.body], { type: "text/markdown;charset=utf-8" });
  const uploads = [{ key: episodeBodyPath(episode.uid), blob: bodyBlob, kind: "body" }];
  const next = { youtube: episode.youtube || null, body: null, image: null, audio: null };

  for (const kind of ["image", "audio"]) {
    const file = files[`${kind}File`];
    const existingItem = episode.storageData?.[kind] ?? null;
    const existingUrl = episode[kind] || "";
    if (file) {
      uploads.push({ key: mediaKey(episode.uid, kind, file.name), blob: file, kind });
    } else if (episode[`${kind}Path`] && switching) {
      uploads.push({ key: episode[`${kind}Path`], blob: await fetchBlob(existingUrl, kind), kind });
    } else if (episode[`${kind}Path`] && existingItem) {
      next[kind] = existingItem;
    }
  }

  const uploaded = await uploadR2Items(episode.uid, uploads, pin);
  for (let index = 0; index < uploads.length; index += 1) next[uploads[index].kind] = uploaded[index];
  return next;
}

export async function saveEpisode(episode, files = {}, pin) {
  const requiresR2 = [files.imageFile, files.audioFile].filter(Boolean).some((file) => file.size > MAX_SUPABASE_FILE_BYTES);
  const provider = episode.storageProvider === "r2" || requiresR2 ? "r2" : "supabase";
  let data;

  if (provider === "r2") {
    data = await buildR2Data(episode, files, pin);
  } else {
    const previous = episode.storageData ?? {};
    const image = files.imageFile
      ? await uploadSupabaseFile(episode.uid, "image", files.imageFile, pin)
      : episode.imagePath ? previous.image ?? legacyItem(episode.imagePath, "image/*") : null;
    const audio = files.audioFile
      ? await uploadSupabaseFile(episode.uid, "audio", files.audioFile, pin)
      : episode.audioPath ? previous.audio ?? legacyItem(episode.audioPath, "audio/*") : null;
    data = {
      youtube: episode.youtube || null,
      body: { key: episodeBodyPath(episode.uid), size: new TextEncoder().encode(episode.body).byteLength, mime: "text/markdown;charset=utf-8" },
      image,
      audio,
    };
  }

  const result = await adminRequest(pin, {
    action: "save",
    episode: toRow(episode, provider, data),
    body: provider === "supabase" ? episode.body : undefined,
  });
  writeEpisodeBodyCache(episode.uid, episode.body);
  return {
    ...episode,
    bodyLoaded: true,
    storageProvider: result.provider,
    storageBytes: result.storageBytes,
    storageData: result.data,
    imagePath: result.data.image?.key ?? "",
    audioPath: result.data.audio?.key ?? "",
    image: publicMediaUrl(result.provider, result.data.image?.key),
    audio: publicMediaUrl(result.provider, result.data.audio?.key),
  };
}

export async function removeEpisode(episode, pin) {
  await adminRequest(pin, { action: "delete", id: episode.uid });
  removeEpisodeBodyCache(episode.uid);
}

export async function renumberEpisodes(pin) {
  return adminRequest(pin, { action: "renumber" });
}

export async function getStorageStatus(pin) {
  const status = await adminRequest(pin, { action: "storage-status" });
  if (status.settings?.r2PublicUrl) publicStorageConfig = { r2Ready: status.settings.r2Ready, r2PublicUrl: status.settings.r2PublicUrl };
  return status;
}

export async function saveStorageSettings(settings, pin) {
  return adminRequest(pin, { action: "settings-save", ...settings });
}

export async function setupR2(config, pin) {
  const result = await adminRequest(pin, { action: "r2-setup", ...config });
  publicStorageConfig = { r2Ready: true, r2PublicUrl: result.publicUrl };
  return result;
}

export async function changeAdminPin(nextPin, pin) {
  return adminRequest(pin, { action: "change-pin", nextPin });
}

export async function migrateEpisodeStorage(episode, target, pin, onProgress = () => {}) {
  const started = await adminRequest(pin, { action: "migration-start", episodeId: episode.uid, target });
  const items = [started.data.body, started.data.image, started.data.audio].filter(Boolean);
  try {
    onProgress({ current: 0, total: items.length, label: "Préparation" });
    if (target === "r2") {
      const transfers = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        onProgress({ current: index, total: items.length, label: item.key });
        transfers.push({ ...item, blob: await fetchBlob(publicMediaUrl("supabase", item.key), item.key) });
      }
      await uploadR2Items(episode.uid, transfers, pin);
    } else {
      const signed = await adminRequest(pin, {
        action: "migration-supabase-sign",
        episodeId: episode.uid,
        objects: items.map((item) => item.key),
      });
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        onProgress({ current: index, total: items.length, label: item.key });
        const blob = await fetchBlob(publicMediaUrl("r2", item.key), item.key);
        const targetObject = signed.objects.find((object) => object.key === item.key);
        const { error } = await getClient().storage.from(MEDIA_BUCKET).uploadToSignedUrl(item.key, targetObject.token, blob, {
          cacheControl: "3600",
          contentType: item.mime || blob.type,
        });
        if (error) throw error;
      }
    }
    onProgress({ current: items.length, total: items.length, label: "Vérification" });
    const result = await adminRequest(pin, { action: "migration-finish", jobId: started.job.id });
    return result;
  } catch (error) {
    await adminRequest(pin, { action: "migration-error", jobId: started.job.id, error: error.message }).catch(() => {});
    throw error;
  }
}
