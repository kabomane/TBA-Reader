import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://lfgllmxdcnylabdcvmsk.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_YAuJXFnXZDQBWjvKjJ2-0A_lTOKdpYm";
const MEDIA_BUCKET = "tba-media";
const MAX_SUPABASE_FILE_BYTES = 50_000_000;
const EPISODE_REQUEST_TIMEOUT = 8000;
const EPISODE_RETRY_DELAY = 1200;
const EPISODE_RECOVERY_DELAY = 15000;
const EPISODE_BODY_CACHE_PREFIX = "tba-episode-body-v1:";
const PUBLIC_STORAGE_CACHE_KEY = "tba-public-storage-v1";
const PUBLIC_STORAGE_REFRESH_MS = 30 * 60 * 1000;
const ADMIN_SESSION_STARTED_KEY = "tba-admin-session-started-v1";
const ADMIN_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const ADMIN_USER_KEY = "tba-admin@bizave.local";
// Un commentaire Markdown/HTML est stocké pour les épisodes sans texte, sans rien afficher au lecteur.
const EMPTY_EPISODE_BODY = "<!-- {NOTHING} -->";
export const EPISODE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const EPISODE_COLUMNS = [
  "id", "share_id", "number", "title", "type", "tags", "published_on", "duration",
  "description", "palette", "token", "created_at",
  "storage_provider", "storage_bytes", "data",
].join(",");

const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
let publicStorageConfig = { r2Ready: false, r2Enabled: false, r2PublicUrl: "" };
let publicStorageSavedAt = 0;

function getClient() {
  return client;
}

function encodeObjectKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function publicMediaUrl(provider, key) {
  if (!key) return "";
  readPublicStorageCache();
  if (provider === "r2" && publicStorageConfig.r2PublicUrl) {
    return `${publicStorageConfig.r2PublicUrl}/${encodeObjectKey(key)}`;
  }
  return getClient().storage.from(MEDIA_BUCKET).getPublicUrl(key).data.publicUrl;
}

function episodeBodyPath(episodeId) {
  return `episodes/${episodeId}/body.md`;
}

function storageBody(body) {
  return String(body ?? "").trim() ? String(body) : EMPTY_EPISODE_BODY;
}

function readerBody(body) {
  return String(body ?? "").trim() === EMPTY_EPISODE_BODY ? "" : String(body ?? "");
}

function fileMime(file) {
  if (/\.aac$/i.test(file?.name || "")) return "audio/aac";
  return file?.type || "application/octet-stream";
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

function readPublicStorageCache() {
  if (publicStorageSavedAt) return;
  try {
    const saved = JSON.parse(localStorage.getItem(PUBLIC_STORAGE_CACHE_KEY));
    if (!saved || saved.version !== 1 || !Number.isFinite(saved.savedAt) || !saved.config) return;
    publicStorageSavedAt = saved.savedAt;
    publicStorageConfig = { ...publicStorageConfig, ...saved.config };
  } catch {
    // Cache facultatif.
  }
}

function storePublicStorageConfig(config) {
  publicStorageConfig = { ...publicStorageConfig, ...config };
  publicStorageSavedAt = Date.now();
  try {
    localStorage.setItem(PUBLIC_STORAGE_CACHE_KEY, JSON.stringify({
      version: 1,
      savedAt: publicStorageSavedAt,
      config: publicStorageConfig,
    }));
  } catch {
    // Cache facultatif.
  }
}

async function refreshPublicStorageConfig(force = false) {
  readPublicStorageCache();
  if (!force && publicStorageSavedAt && Date.now() - publicStorageSavedAt < PUBLIC_STORAGE_REFRESH_MS) return;
  const { data, error } = await getClient().rpc("tba_public_storage_config");
  if (!error && data) storePublicStorageConfig(data);
}

async function fetchEpisodes() {
  const configRequest = refreshPublicStorageConfig();
  const episodesResult = await getClient().from("episodes").select(EPISODE_COLUMNS).order("created_at", { ascending: false });
  await configRequest;
  if (episodesResult.error) throw episodesResult.error;
  return episodesResult.data.map(fromRow);
}

export async function getEpisodesSnapshot() {
  return fetchEpisodes();
}

export function getPublicStorageUrl(provider, key) {
  return publicMediaUrl(provider, key);
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
  const body = readerBody(await response.text());
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

function adminSessionStartedAt(session) {
  const localValue = Number(localStorage.getItem(ADMIN_SESSION_STARTED_KEY));
  if (Number.isFinite(localValue) && localValue > 0) return localValue;
  const signedInAt = Date.parse(session?.user?.last_sign_in_at ?? "");
  return Number.isFinite(signedInAt) ? signedInAt : 0;
}

function validAdminUser(user) {
  return user?.email === ADMIN_USER_KEY && user?.app_metadata?.role === "tba_admin";
}

export async function getAdminSession() {
  const { data: { session } } = await getClient().auth.getSession();
  const startedAt = adminSessionStartedAt(session);
  if (!session || !validAdminUser(session.user) || !startedAt || Date.now() - startedAt >= ADMIN_SESSION_MAX_AGE_MS) {
    if (session) await getClient().auth.signOut({ scope: "local" }).catch(() => {});
    localStorage.removeItem(ADMIN_SESSION_STARTED_KEY);
    return null;
  }
  if (!localStorage.getItem(ADMIN_SESSION_STARTED_KEY)) {
    localStorage.setItem(ADMIN_SESSION_STARTED_KEY, String(startedAt));
  }
  return session;
}

export function watchAdminSession(onChange) {
  const { data: { subscription } } = getClient().auth.onAuthStateChange(() => {
    window.setTimeout(() => {
      getAdminSession().then(onChange).catch(() => onChange(null));
    }, 0);
  });
  return () => subscription.unsubscribe();
}

async function bootstrapAdmin(pin) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/tba-admin`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json", "x-tba-pin": pin },
    body: JSON.stringify({ action: "bootstrap-admin" }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Initialisation du compte créateur refusée.");
}

export async function signInAdmin(pin) {
  try {
    let result = await getClient().auth.signInWithPassword({ email: ADMIN_USER_KEY, password: pin });
    if (result.error) {
      await bootstrapAdmin(pin);
      result = await getClient().auth.signInWithPassword({ email: ADMIN_USER_KEY, password: pin });
    }
    if (result.error) throw result.error;
    if (!validAdminUser(result.data.user)) {
      await getClient().auth.signOut({ scope: "local" });
      throw new Error("Ce compte n’est pas autorisé à administrer TBA Reader.");
    }
    const startedAt = Date.parse(result.data.user.last_sign_in_at ?? "");
    localStorage.setItem(ADMIN_SESSION_STARTED_KEY, String(Number.isFinite(startedAt) ? startedAt : Date.now()));
    return result.data.session;
  } catch (error) {
    localStorage.removeItem(ADMIN_SESSION_STARTED_KEY);
    throw error;
  }
}

export async function signOutAdmin() {
  localStorage.removeItem(ADMIN_SESSION_STARTED_KEY);
  const { error } = await getClient().auth.signOut({ scope: "local" });
  if (error) throw error;
}

async function adminRequest(payload) {
  const session = await getAdminSession();
  if (!session) throw new Error("Session créateur expirée. Reconnecte-toi.");
  const response = await fetch(`${SUPABASE_URL}/functions/v1/tba-admin`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Action créateur refusée.");
  return data;
}

async function uploadSupabaseFile(episodeId, kind, file, uploadedKeys) {
  const path = mediaKey(episodeId, kind, file.name);
  const { error } = await getClient().storage.from(MEDIA_BUCKET).upload(path, file, {
    cacheControl: "3600",
    contentType: fileMime(file),
    upsert: false,
  });
  if (error) throw error;
  uploadedKeys.push(path);
  return { key: path, size: file.size, mime: fileMime(file), etag: null };
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

async function uploadR2Items(episodeId, items, uploadedKeys = null) {
  if (!items.length) return [];
  const signing = await adminRequest({
    action: "r2-upload-urls",
    episodeId,
    objects: items.map((item) => item.key),
  });
  const outcomes = await Promise.allSettled(items.map(async (item) => {
    const target = signing.objects?.find((object) => object.key === item.key);
    if (!target?.url) throw new Error(`URL R2 absente pour ${item.key}.`);
    const response = await fetch(target.url, {
      method: "PUT",
      headers: { "Content-Type": item.blob.type || item.mime || "application/octet-stream" },
      body: item.blob,
    });
    if (!response.ok) throw new Error(`Envoi R2 refusé pour ${item.key} (${response.status}).`);
    if (uploadedKeys) uploadedKeys.push(item.key);
    return {
      key: item.key,
      size: item.blob.size,
      mime: item.blob.type || item.mime || "application/octet-stream",
      etag: response.headers.get("etag"),
    };
  }));
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed) throw failed.reason;
  return outcomes.map((outcome) => outcome.value);
}

async function buildR2Data(episode, files, uploadedKeys) {
  const switching = episode.storageProvider !== "r2";
  const uploads = [];
  const next = { youtube: episode.youtube || null, body: null, image: null, audio: null };

  // L'audio est le média le plus susceptible d'être refusé : l'envoyer avant
  // l'image évite de créer une miniature orpheline si cet envoi échoue.
  for (const kind of ["audio", "image"]) {
    const file = files[`${kind}File`];
    const existingItem = episode.storageData?.[kind] ?? null;
    const existingUrl = episode[kind] || "";
    if (file) {
      uploads.push({ key: mediaKey(episode.uid, kind, file.name), blob: file, kind, mime: fileMime(file) });
    } else if (episode[`${kind}Path`] && switching) {
      uploads.push({ key: episode[`${kind}Path`], blob: await fetchBlob(existingUrl, kind), kind });
    } else if (episode[`${kind}Path`] && existingItem) {
      next[kind] = existingItem;
    }
  }
  if (switching || files.bodyChanged !== false || !episode.storageData?.body) {
    uploads.push({
      key: episodeBodyPath(episode.uid),
      blob: new Blob([storageBody(episode.body)], { type: "text/markdown;charset=utf-8" }),
      kind: "body",
    });
  } else {
    next.body = episode.storageData.body;
  }

  const uploaded = await uploadR2Items(episode.uid, uploads, uploadedKeys);
  for (let index = 0; index < uploads.length; index += 1) next[uploads[index].kind] = uploaded[index];
  return next;
}

export async function saveEpisode(episode, files = {}) {
  const requiresR2 = [files.imageFile, files.audioFile].filter(Boolean).some((file) => file.size > MAX_SUPABASE_FILE_BYTES);
  const provider = episode.storageProvider === "r2" || requiresR2 ? "r2" : "supabase";
  const uploadedKeys = [];
  let data;

  let result;
  try {
    if (provider === "r2") {
      data = await buildR2Data(episode, files, uploadedKeys);
    } else {
      const previous = episode.storageData ?? {};
      const audio = files.audioFile
        ? await uploadSupabaseFile(episode.uid, "audio", files.audioFile, uploadedKeys)
        : episode.audioPath ? previous.audio ?? legacyItem(episode.audioPath, "audio/*") : null;
      const image = files.imageFile
        ? await uploadSupabaseFile(episode.uid, "image", files.imageFile, uploadedKeys)
        : episode.imagePath ? previous.image ?? legacyItem(episode.imagePath, "image/*") : null;
      data = {
        youtube: episode.youtube || null,
        body: { key: episodeBodyPath(episode.uid), size: new TextEncoder().encode(episode.body).byteLength, mime: "text/markdown;charset=utf-8" },
        image,
        audio,
      };
    }

    const body = storageBody(episode.body);
    result = await adminRequest({
      action: "save",
      episode: toRow(episode, provider, data),
      body: provider === "supabase" ? body : undefined,
      bodyChanged: files.bodyChanged !== false,
    });
  } catch (error) {
    if (uploadedKeys.length) {
      await adminRequest({
        action: "cleanup-upload",
        episodeId: episode.uid,
        provider,
        objects: uploadedKeys,
      }).catch(() => {});
    }
    throw error;
  }
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

export async function removeEpisode(episode) {
  await adminRequest({ action: "delete", id: episode.uid });
  removeEpisodeBodyCache(episode.uid);
}

export async function renumberEpisodes() {
  return adminRequest({ action: "renumber" });
}

export async function getStorageStatus() {
  const status = await adminRequest({ action: "storage-status" });
  if (status.settings?.r2PublicUrl) storePublicStorageConfig({
    r2Ready: status.settings.r2Ready,
    r2Enabled: status.settings.r2Enabled,
    r2PublicUrl: status.settings.r2PublicUrl,
  });
  return status;
}

export async function saveStorageSettings(settings) {
  return adminRequest({ action: "settings-save", ...settings });
}

export async function setupR2(config) {
  const result = await adminRequest({ action: "r2-setup", ...config });
  storePublicStorageConfig({ r2Ready: true, r2PublicUrl: result.publicUrl });
  return result;
}

export async function setupR2CustomDomain(domain, zoneId) {
  const result = await adminRequest({ action: "r2-custom-domain", domain, zoneId });
  if (result.active && result.publicUrl) {
    storePublicStorageConfig({ r2Ready: true, r2PublicUrl: result.publicUrl });
  }
  return result;
}

export async function toggleR2(enabled) {
  const result = await adminRequest({ action: "r2-toggle", enabled });
  storePublicStorageConfig({ r2Enabled: result.enabled });
  return result;
}

export async function changeAdminPin(nextPin) {
  return adminRequest({ action: "change-pin", nextPin });
}

export async function migrateEpisodeStorage(episode, target, onProgress = () => {}) {
  const started = await adminRequest({ action: "migration-start", episodeId: episode.uid, target });
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
      await uploadR2Items(episode.uid, transfers);
    } else {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        onProgress({ current: index, total: items.length, label: item.key });
        const blob = await fetchBlob(publicMediaUrl("r2", item.key), item.key);
        const { error } = await getClient().storage.from(MEDIA_BUCKET).upload(item.key, blob, {
          cacheControl: "3600",
          contentType: item.mime || blob.type,
          upsert: true,
        });
        if (error) throw error;
      }
    }
    onProgress({ current: items.length, total: items.length, label: "Vérification" });
    const result = await adminRequest({ action: "migration-finish", jobId: started.job.id });
    return {
      ...episode,
      storageProvider: result.provider,
      storageBytes: result.storageBytes,
      storageData: result.data,
      imagePath: result.data.image?.key ?? "",
      audioPath: result.data.audio?.key ?? "",
      image: publicMediaUrl(result.provider, result.data.image?.key),
      audio: publicMediaUrl(result.provider, result.data.audio?.key),
    };
  } catch (error) {
    await adminRequest({ action: "migration-error", jobId: started.job.id, error: error.message }).catch(() => {});
    throw error;
  }
}
