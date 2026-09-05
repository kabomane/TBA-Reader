import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.7";
import { AwsClient } from "npm:aws4fetch@1.0.20";

const SUPABASE_BUCKET = "tba-media";
const MAX_SUPABASE_FILE_BYTES = 50_000_000;
const WHISPER_MODELS = [
  {
    id: "tiny",
    name: "Tiny Q5_1",
    qualifier: "rapide",
    key: "whisper/ggml-tiny-q5_1-v1.bin",
    bytes: 32_152_673,
    sha256: "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
    sourcePath: "/whisper/ggml-tiny-q5_1.bin",
  },
  {
    id: "base",
    name: "Base Q5_1",
    qualifier: "précis",
    key: "whisper/ggml-base-q5_1-v1.bin",
    bytes: 59_707_625,
    sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
    sourcePath: "/whisper/ggml-base-q5_1.bin",
  },
] as const;
const WHISPER_BASE_MODEL = WHISPER_MODELS.find((model) => model.id === "base")!;
const ADMIN_USER_KEY = "tba-admin@bizave.local";
const technicalIdPattern = /^[a-zA-Z0-9-]{3,64}$/;
const shareIdPattern = /^[a-z0-9]{8}$/;
const accessTokenPattern = /^[0-9a-f]{16}$/;
const bucketPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const cloudflareZoneIdPattern = /^[a-f0-9]{32}$/;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const attempts = new Map<string, { count: number; blockedUntil: number }>();
const settingsCache = new WeakMap<object, Promise<any>>();
const secretsCache = new WeakMap<object, Map<string, Promise<string>>>();

type Provider = "supabase" | "r2";
type MediaItem = { key: string; size: number; mime: string; etag?: string | null };
type MediaData = { youtube?: string | null; body: MediaItem; image?: MediaItem | null; audio?: MediaItem | null };
type AdminClient = SupabaseClient<any>;

function allowedOrigin(origin: string) {
  if (!origin) return "*";
  try {
    const url = new URL(origin);
    const local = url.hostname === "localhost"
      || url.hostname === "127.0.0.1"
      || /^192\.168\./.test(url.hostname)
      || /^10\./.test(url.hostname)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname);
    const hosted = url.hostname === "tbizave-reader.web.app"
      || url.hostname === "tbizave-reader.firebaseapp.com"
      || url.hostname === "bizave.kabomane.me";
    return local || hosted ? origin : "https://tbizave-reader.web.app";
  } catch {
    return "https://tbizave-reader.web.app";
  }
}

function corsHeaders(req: Request) {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(req.headers.get("origin") ?? ""),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tba-pin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(req: Request, body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), ...extraHeaders, "Content-Type": "application/json" },
  });
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeFilename(filename: string) {
  return filename
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(-140);
}

function bodyPath(episodeId: string) {
  return `episodes/${episodeId}/body.md`;
}

function validEpisodeKey(key: unknown, episodeId: string) {
  return typeof key === "string" && key.startsWith(`episodes/${episodeId}/`) && key.length <= 1024;
}

function youtubeVideoId(value: unknown) {
  const input = String(value ?? "").trim();
  if (!input) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  try {
    const parsed = new URL(input);
    const host = parsed.hostname.replace(/^(?:www\.|m\.)/, "");
    if (host === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : "";
    }
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const queryId = parsed.searchParams.get("v") ?? "";
      if (/^[a-zA-Z0-9_-]{11}$/.test(queryId)) return queryId;
      return parsed.pathname.match(/^\/(?:embed|shorts|live)\/([a-zA-Z0-9_-]{11})(?:\/|$)/)?.[1] ?? "";
    }
  } catch {
    return "";
  }
  return "";
}

function validBaseEpisode(episode: Record<string, unknown>) {
  return typeof episode.id === "string"
    && technicalIdPattern.test(episode.id)
    && typeof episode.title === "string"
    && episode.title.trim().length > 0
    && ["Texte", "Vidéo", "Vocal"].includes(String(episode.type))
    && Array.isArray(episode.tags)
    && typeof episode.published_on === "string"
    && typeof episode.description === "string"
    && (episode.token == null || (typeof episode.token === "string" && accessTokenPattern.test(episode.token)))
    && typeof episode.created_at === "string";
}

function mediaItems(data: MediaData) {
  return [data.body, data.image, data.audio].filter(Boolean) as MediaItem[];
}

function normalizeMediaData(raw: unknown, episodeId: string, youtube: string | null): MediaData {
  const incoming = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const normalize = (value: unknown, required = false): MediaItem | null => {
    if (!value || typeof value !== "object") {
      if (required) throw new Error("Fichier body.md absent.");
      return null;
    }
    const item = value as Record<string, unknown>;
    const key = String(item.key ?? "");
    const size = Number(item.size ?? 0);
    const mime = String(item.mime ?? "application/octet-stream");
    if (!validEpisodeKey(key, episodeId) || !Number.isFinite(size) || size < 0) {
      throw new Error("Métadonnées média invalides.");
    }
    return { key, size, mime, etag: item.etag ? String(item.etag) : null };
  };
  return {
    youtube,
    body: normalize(incoming.body, true) as MediaItem,
    image: normalize(incoming.image),
    audio: normalize(incoming.audio),
  };
}

function encodeObjectKey(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function settings(supabase: AdminClient) {
  let pending = settingsCache.get(supabase);
  if (!pending) {
    pending = (async () => {
      const { data, error } = await supabase.from("tba_settings").select("*").eq("id", true).single();
      if (error) throw error;
      return data;
    })();
    settingsCache.set(supabase, pending);
  }
  return pending;
}

async function secret(supabase: AdminClient, name: string) {
  let cache = secretsCache.get(supabase);
  if (!cache) {
    cache = new Map();
    secretsCache.set(supabase, cache);
  }
  let pending = cache.get(name);
  if (!pending) {
    pending = (async () => {
      const { data, error } = await supabase.rpc("tba_get_secret", { secret_name: name });
      if (error) throw error;
      return data ? String(data) : "";
    })();
    cache.set(name, pending);
  }
  return pending;
}

async function setSecret(supabase: AdminClient, name: string, value: string, description: string) {
  const { error } = await supabase.rpc("tba_upsert_secret", {
    secret_name: name,
    secret_value: value,
    secret_description: description,
  });
  if (error) throw error;
  secretsCache.get(supabase)?.delete(name);
}

async function authenticateLegacyPin(req: Request, supabase: AdminClient) {
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown";
  const state = attempts.get(ip);
  if (state?.blockedUntil && state.blockedUntil > Date.now()) {
    return { ok: false, retryAfter: Math.ceil((state.blockedUntil - Date.now()) / 1000) };
  }
  const pin = req.headers.get("x-tba-pin") ?? "";
  const expected = await secret(supabase, "tba_admin_pin_hash");
  const ok = pin.length === 6 && await sha256(pin) === expected;
  if (ok) {
    attempts.delete(ip);
    return { ok: true, retryAfter: 0 };
  }
  const count = (state?.count ?? 0) + 1;
  const blockedUntil = count >= 5 ? Date.now() + Math.min(300_000, 15_000 * 2 ** (count - 5)) : 0;
  attempts.set(ip, { count, blockedUntil });
  return { ok: false, retryAfter: blockedUntil ? Math.ceil((blockedUntil - Date.now()) / 1000) : 0 };
}

async function authenticateAdmin(req: Request, supabase: AdminClient) {
  const authorization = req.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!token) return { ok: false, userId: "" };
  const { data, error } = await supabase.auth.getClaims(token);
  const claims = data?.claims as Record<string, unknown> | undefined;
  const appMetadata = claims?.app_metadata as Record<string, unknown> | undefined;
  const ok = !error
    && claims?.email === ADMIN_USER_KEY
    && appMetadata?.role === "tba_admin"
    && typeof claims?.sub === "string";
  return { ok, userId: ok ? String(claims?.sub) : "" };
}

async function cloudflareFetch(accountId: string, token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = data.errors?.[0]?.message || `Cloudflare a répondu ${response.status}.`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return data.result;
}

async function r2Context(supabase: AdminClient) {
  const config = await settings(supabase);
  if (!config.r2_ready || !config.r2_account_id || !config.r2_bucket || !config.r2_public_url) {
    throw new Error("Cloudflare R2 doit être configuré.");
  }
  const token = await secret(supabase, "tba_cloudflare_api_token");
  if (!token) throw new Error("Jeton Cloudflare absent.");
  return { config, token };
}

async function r2WriteContext(supabase: AdminClient) {
  const context = await r2Context(supabase);
  if (!context.config.r2_enabled) throw new Error("Cloudflare R2 est désactivé.");
  return context;
}

async function activateR2CustomDomain(supabase: AdminClient, domain: string, zoneId: string) {
  const { config, token } = await r2Context(supabase);
  const basePath = `/accounts/${config.r2_account_id}/r2/buckets/${encodeURIComponent(config.r2_bucket)}/domains/custom`;
  const listed = await cloudflareFetch(config.r2_account_id, token, basePath);
  const exists = Array.isArray(listed?.domains) && listed.domains.some((item: { domain?: string }) => item.domain === domain);
  if (!exists) {
    await cloudflareFetch(config.r2_account_id, token, basePath, {
      method: "POST",
      body: JSON.stringify({ domain, zoneId, enabled: true, minTLS: "1.2" }),
    });
  }

  const detail = await cloudflareFetch(config.r2_account_id, token, `${basePath}/${encodeURIComponent(domain)}`);
  const active = detail?.enabled === true && detail?.status?.ownership === "active" && detail?.status?.ssl === "active";
  if (!active) return { active: false, status: detail?.status ?? null };

  const publicUrl = `https://${domain}`;
  const now = new Date().toISOString();
  const { error } = await supabase.from("tba_settings").update({ r2_public_url: publicUrl, updated_at: now }).eq("id", true);
  if (error) throw error;
  const { error: publicConfigError } = await supabase.from("tba_public_storage").update({ r2_public_url: publicUrl }).eq("id", true);
  if (publicConfigError) throw publicConfigError;
  return { active: true, publicUrl, status: detail.status };
}

async function r2UploadUrls(supabase: AdminClient, objects: string[]) {
  const { config, token } = await r2WriteContext(supabase);
  const credentials = await cloudflareFetch(
    config.r2_account_id,
    token,
    `/accounts/${config.r2_account_id}/r2/temp-access-credentials`,
    {
      method: "POST",
      body: JSON.stringify({
        bucket: config.r2_bucket,
        parentAccessKeyId: config.r2_parent_access_key_id,
        permission: "object-read-write",
        ttlSeconds: 900,
        objects,
      }),
    },
  );
  const signer = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    region: "auto",
    service: "s3",
  });
  return {
    objects: await Promise.all(objects.map(async (key) => {
      const url = `https://${config.r2_account_id}.r2.cloudflarestorage.com/${config.r2_bucket}/${encodeObjectKey(key)}`;
      const signed = await signer.sign(url, { method: "PUT", aws: { signQuery: true } });
      return { key, url: signed.url };
    })),
  };
}

async function verifyR2(supabase: AdminClient, items: MediaItem[]) {
  const { config } = await r2Context(supabase);
  await Promise.all(items.map(async (item) => {
    const response = await fetch(`${config.r2_public_url}/${encodeObjectKey(item.key)}`, { method: "HEAD" });
    if (!response.ok) throw new Error(`Fichier R2 introuvable : ${item.key}`);
    const size = Number(response.headers.get("content-length") ?? item.size);
    if (item.size && size !== item.size) throw new Error(`Taille R2 incorrecte : ${item.key}`);
  }));
}

function r2CorsOrigins(origin: string) {
  return [...new Set([
    origin === "*" ? "" : origin,
    "https://tbizave-reader.web.app",
    "https://tbizave-reader.firebaseapp.com",
    "https://bizave.kabomane.me",
  ].filter(Boolean))];
}

async function configureR2Cors(accountId: string, token: string, bucket: string, origin: string) {
  await cloudflareFetch(accountId, token, `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/cors`, {
    method: "PUT",
    body: JSON.stringify({ rules: [
      {
        id: "tba-reader-public-read",
        allowed: { methods: ["GET", "HEAD"], origins: ["*"], headers: ["*"] },
        exposeHeaders: ["etag", "content-length"],
        maxAgeSeconds: 3600,
      },
      {
        id: "tba-reader-admin-write",
        allowed: { methods: ["PUT"], origins: r2CorsOrigins(origin), headers: ["*"] },
        exposeHeaders: ["etag"],
        maxAgeSeconds: 3600,
      },
    ] }),
  });
}

async function supabaseObjectInfo(supabase: AdminClient, keys: string[]) {
  const { data, error } = await supabase.rpc("tba_object_info", { object_keys: keys });
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as MediaItem[];
}

async function verifySupabase(supabase: AdminClient, items: MediaItem[], knownItems?: MediaItem[]) {
  if (items.some((item) => item.size > MAX_SUPABASE_FILE_BYTES)) {
    throw new Error("Un fichier dépasse la limite Supabase de 50 Mo.");
  }
  const actual = knownItems ?? await supabaseObjectInfo(supabase, items.map((item) => item.key));
  for (const item of items) {
    const found = actual.find((candidate) => candidate.key === item.key);
    if (!found) throw new Error(`Fichier Supabase introuvable : ${item.key}`);
    if (item.size && Number(found.size) !== item.size) throw new Error(`Taille Supabase incorrecte : ${item.key}`);
  }
}

async function deleteR2Objects(supabase: AdminClient, keys: string[]) {
  if (!keys.length) return;
  const { config, token } = await r2Context(supabase);
  for (const key of keys) {
    await cloudflareFetch(
      config.r2_account_id,
      token,
      `/accounts/${config.r2_account_id}/r2/buckets/${encodeURIComponent(config.r2_bucket)}/objects/${encodeObjectKey(key)}`,
      { method: "DELETE" },
    );
  }
}

async function deleteObjects(supabase: AdminClient, provider: Provider, keys: string[]) {
  if (!keys.length) return;
  if (provider === "supabase") {
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(keys);
    if (error) throw error;
  } else {
    await deleteR2Objects(supabase, keys);
  }
}

function isMissingR2Object(error: unknown) {
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return status === 404 || /specified key does not exist|no such key|nosuchkey|object not found/i.test(message);
}

async function deleteWhisperObjects(supabase: AdminClient) {
  for (const model of WHISPER_MODELS) {
    try {
      await deleteR2Objects(supabase, [model.key]);
    } catch (error) {
      if (!isMissingR2Object(error)) throw error;
    }
  }
}

async function publishWhisper(
  supabase: AdminClient,
  ready: boolean,
  modelUrls: { tiny?: string; base?: string } = {},
) {
  const { error } = await supabase.from("tba_public_whisper").update({
    whisper_ready: ready,
    whisper_public_url: ready ? modelUrls.base ?? null : null,
    whisper_tiny_public_url: ready ? modelUrls.tiny ?? null : null,
  }).eq("id", true);
  if (error) throw error;
}

async function updateWhisperState(supabase: AdminClient, values: Record<string, unknown>) {
  const { error } = await supabase.from("tba_settings").update({
    ...values,
    updated_at: new Date().toISOString(),
  }).eq("id", true);
  if (error) throw error;
}

function whisperLocksR2(config: Record<string, unknown>) {
  return ["installing", "active", "cleanup_required"].includes(String(config.whisper_status));
}

async function storageStatus(supabase: AdminClient) {
  const [config, usageResult, orphanResult, episodesResult, jobsResult, whisperResult] = await Promise.all([
    settings(supabase),
    supabase.rpc("tba_storage_bytes"),
    supabase.rpc("tba_orphan_stats"),
    supabase.from("episodes").select("id,share_id,number,title,storage_provider,storage_bytes,data"),
    supabase.from("tba_storage_jobs")
      .select("id,episode_id,source_provider,target_provider,status,manifest,error,updated_at")
      .in("status", ["queued", "copying", "verifying", "committing", "cleanup", "error"])
      .order("created_at", { ascending: false }),
    supabase.from("tba_public_whisper").select("whisper_ready").eq("id", true).single(),
  ]);
  if (usageResult.error) throw usageResult.error;
  if (orphanResult.error) throw orphanResult.error;
  if (episodesResult.error) throw episodesResult.error;
  if (jobsResult.error) throw jobsResult.error;
  if (whisperResult.error) throw whisperResult.error;
  const r2Bytes = (episodesResult.data ?? [])
    .filter((episode) => episode.storage_provider === "r2")
    .reduce((sum, episode) => sum + Number(episode.storage_bytes || 0), 0);
  return {
    settings: {
      autoMigrationEnabled: config.auto_migration_enabled,
      triggerPercent: config.trigger_percent,
      targetPercent: config.target_percent,
      quotaBytes: Number(config.quota_bytes),
      r2Ready: config.r2_ready,
      r2Enabled: config.r2_enabled,
      r2Bucket: config.r2_bucket,
      r2PublicUrl: config.r2_public_url,
      whisperStatus: config.whisper_status,
      whisperReady: Boolean(whisperResult.data?.whisper_ready),
      whisperModelKey: config.whisper_model_key,
      whisperError: config.whisper_error,
      whisperInstalledAt: config.whisper_installed_at,
    },
    supabaseBytes: Number(usageResult.data ?? 0),
    r2Bytes,
    orphan: orphanResult.data ?? { objects: 0, bytes: 0 },
    episodes: episodesResult.data ?? [],
    jobs: jobsResult.data ?? [],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Méthode refusée." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json(req, { error: "Configuration serveur absente." }, 500);
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const payload = await req.json();
    if (payload.action === "bootstrap-admin") {
      const legacyAuth = await authenticateLegacyPin(req, supabase);
      if (!legacyAuth.ok) {
        return json(
          req,
          { error: legacyAuth.retryAfter ? `Trop de tentatives. Réessaie dans ${legacyAuth.retryAfter}s.` : "Code PIN incorrect." },
          401,
          legacyAuth.retryAfter ? { "Retry-After": String(legacyAuth.retryAfter) } : {},
        );
      }
      const { data: users, error: usersError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (usersError) throw usersError;
      const existing = users.users.find((user) => user.email === ADMIN_USER_KEY);
      if (!existing) {
        const pin = req.headers.get("x-tba-pin") ?? "";
        const { error: createError } = await supabase.auth.admin.createUser({
          email: ADMIN_USER_KEY,
          password: pin,
          email_confirm: true,
          app_metadata: { role: "tba_admin" },
        });
        if (createError) throw createError;
      }
      return json(req, { ok: true, created: !existing });
    }

    const auth = await authenticateAdmin(req, supabase);
    if (!auth.ok) {
      return json(req, { error: "Session créateur invalide ou expirée." }, 401);
    }

    if (payload.action === "verify") return json(req, { ok: true });

    if (payload.action === "storage-status") return json(req, await storageStatus(supabase));

    if (payload.action === "settings-save") {
      const trigger = Number(payload.triggerPercent);
      const target = Number(payload.targetPercent);
      if (!Number.isInteger(trigger) || !Number.isInteger(target) || trigger < 2 || trigger > 99 || target < 1 || target >= trigger) {
        return json(req, { error: "Seuils de stockage invalides." }, 400);
      }
      const { error } = await supabase.from("tba_settings").update({
        auto_migration_enabled: Boolean(payload.autoMigrationEnabled),
        trigger_percent: trigger,
        target_percent: target,
        updated_at: new Date().toISOString(),
      }).eq("id", true);
      if (error) throw error;
      return json(req, { ok: true });
    }

    if (payload.action === "r2-toggle") {
      const enabled = Boolean(payload.enabled);
      const config = await settings(supabase);
      if (!enabled && whisperLocksR2(config)) {
        return json(req, { error: "Désactive Whisper avant de désactiver Cloudflare R2." }, 409);
      }
      if (enabled) {
        const { config: r2Config, token } = await r2Context(supabase);
        await cloudflareFetch(r2Config.r2_account_id, token, `/accounts/${r2Config.r2_account_id}/tokens/verify`);
        await cloudflareFetch(
          r2Config.r2_account_id,
          token,
          `/accounts/${r2Config.r2_account_id}/r2/buckets/${encodeURIComponent(r2Config.r2_bucket)}`,
        );
      }
      const { error } = await supabase.from("tba_settings").update({
        r2_enabled: enabled,
        updated_at: new Date().toISOString(),
      }).eq("id", true);
      if (error) throw error;
      return json(req, { ok: true, enabled });
    }

    if (payload.action === "r2-custom-domain") {
      if (whisperLocksR2(await settings(supabase))) {
        return json(req, { error: "Désactive Whisper avant de modifier l’adresse publique R2." }, 409);
      }
      const domain = String(payload.domain ?? "").trim().toLowerCase();
      const zoneId = String(payload.zoneId ?? "").trim().toLowerCase();
      if (!hostnamePattern.test(domain) || !cloudflareZoneIdPattern.test(zoneId)) {
        return json(req, { error: "Domaine ou Zone ID Cloudflare invalide." }, 400);
      }
      return json(req, await activateR2CustomDomain(supabase, domain, zoneId));
    }

    if (payload.action === "change-pin") {
      const nextPin = String(payload.nextPin ?? "");
      if (!/^\d{6}$/.test(nextPin)) return json(req, { error: "Le nouveau PIN doit contenir 6 chiffres." }, 400);
      const { error } = await supabase.auth.admin.updateUserById(auth.userId, { password: nextPin });
      if (error) throw error;
      return json(req, { ok: true });
    }

    if (payload.action === "r2-setup") {
      if (whisperLocksR2(await settings(supabase))) {
        return json(req, { error: "Désactive Whisper avant de reconfigurer Cloudflare R2." }, 409);
      }
      const accountId = String(payload.accountId ?? "").trim();
      const token = String(payload.apiToken ?? "").trim();
      const parentAccessKeyId = String(payload.parentAccessKeyId ?? "").trim();
      const bucket = String(payload.bucket ?? "").trim().toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(accountId) || !token || !parentAccessKeyId || !bucketPattern.test(bucket)) {
        return json(req, { error: "Configuration Cloudflare invalide." }, 400);
      }

      await cloudflareFetch(accountId, token, `/accounts/${accountId}/tokens/verify`);
      try {
        await cloudflareFetch(accountId, token, `/accounts/${accountId}/r2/buckets`, {
          method: "POST",
          body: JSON.stringify({ name: bucket, storageClass: "Standard" }),
        });
      } catch (error) {
        const existing = await cloudflareFetch(accountId, token, `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}`)
          .catch(() => null);
        if (!existing) throw error;
      }

      const origin = allowedOrigin(req.headers.get("origin") ?? "");
      await configureR2Cors(accountId, token, bucket, origin);
      await cloudflareFetch(accountId, token, `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/domains/managed`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
      const managed = await cloudflareFetch(accountId, token, `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/domains/managed`);
      const publicUrl = `https://${managed.domain}`;
      await setSecret(supabase, "tba_cloudflare_api_token", token, "Jeton API Cloudflare limité à R2");
      const { error } = await supabase.from("tba_settings").update({
        r2_account_id: accountId,
        r2_parent_access_key_id: parentAccessKeyId,
        r2_bucket: bucket,
        r2_public_url: publicUrl,
        r2_ready: true,
        updated_at: new Date().toISOString(),
      }).eq("id", true);
      if (error) throw error;
      const { error: publicConfigError } = await supabase.from("tba_public_storage").update({
        r2_ready: true,
        r2_public_url: publicUrl,
      }).eq("id", true);
      if (publicConfigError) throw publicConfigError;
      return json(req, { ok: true, bucket, publicUrl });
    }

    if (payload.action === "whisper-install-start") {
      const config = await settings(supabase);
      if (!config.r2_ready || !config.r2_enabled) {
        return json(req, { error: "Cloudflare R2 doit être configuré et activé." }, 409);
      }
      await publishWhisper(supabase, false);
      await updateWhisperState(supabase, {
        whisper_status: "installing",
        whisper_model_key: WHISPER_BASE_MODEL.key,
        whisper_error: null,
        whisper_installed_at: null,
      });
      const { token } = await r2WriteContext(supabase);
      await configureR2Cors(
        config.r2_account_id,
        token,
        config.r2_bucket,
        allowedOrigin(req.headers.get("origin") ?? ""),
      );
      const signing = await r2UploadUrls(supabase, WHISPER_MODELS.map((model) => model.key));
      const sourceOrigin = allowedOrigin(req.headers.get("origin") ?? "");
      return json(req, {
        ok: true,
        models: WHISPER_MODELS.map((model) => ({
          id: model.id,
          name: model.name,
          qualifier: model.qualifier,
          sourceUrl: `${sourceOrigin}${model.sourcePath}`,
          uploadUrl: signing.objects.find((item: { key: string }) => item.key === model.key)?.url,
          key: model.key,
          expectedBytes: model.bytes,
          expectedSha256: model.sha256,
        })),
      });
    }

    if (payload.action === "whisper-install-finish") {
      const config = await settings(supabase);
      if (config.whisper_status !== "installing" || config.whisper_model_key !== WHISPER_BASE_MODEL.key) {
        return json(req, { error: "Installation Whisper absente ou expirée." }, 409);
      }
      await verifyR2(supabase, WHISPER_MODELS.map((model) => ({
        key: model.key,
        size: model.bytes,
        mime: "application/octet-stream",
      })));
      const modelUrls = Object.fromEntries(WHISPER_MODELS.map((model) => [
        model.id,
        `${config.r2_public_url}/${encodeObjectKey(model.key)}`,
      ])) as { tiny: string; base: string };
      await updateWhisperState(supabase, {
        whisper_status: "active",
        whisper_model_key: WHISPER_BASE_MODEL.key,
        whisper_error: null,
        whisper_installed_at: new Date().toISOString(),
      });
      await publishWhisper(supabase, true, modelUrls);
      return json(req, { ok: true, modelUrl: modelUrls.base, modelUrls });
    }

    if (payload.action === "whisper-install-cancel" || payload.action === "whisper-disable") {
      await publishWhisper(supabase, false);
      try {
        await deleteWhisperObjects(supabase);
        await updateWhisperState(supabase, {
          whisper_status: "disabled",
          whisper_model_key: null,
          whisper_error: null,
          whisper_installed_at: null,
        });
        return json(req, { ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Suppression R2 impossible.";
        await updateWhisperState(supabase, {
          whisper_status: "cleanup_required",
          whisper_model_key: WHISPER_BASE_MODEL.key,
          whisper_error: message,
        });
        return json(req, { error: `Whisper est désactivé, mais ses fichiers R2 n’ont pas pu être supprimés : ${message}` }, 500);
      }
    }

    if (payload.action === "r2-upload-urls") {
      const episodeId = String(payload.episodeId ?? "");
      const objects: string[] = Array.isArray(payload.objects) ? payload.objects.map(String) : [];
      if (!technicalIdPattern.test(episodeId) || !objects.length || objects.some((key) => !validEpisodeKey(key, episodeId))) {
        return json(req, { error: "Chemins R2 invalides." }, 400);
      }
      return json(req, await r2UploadUrls(supabase, objects));
    }

    if (payload.action === "cleanup-upload") {
      const episodeId = String(payload.episodeId ?? "");
      const provider: Provider = payload.provider === "r2" ? "r2" : "supabase";
      const objects: string[] = Array.isArray(payload.objects)
        ? [...new Set<string>(payload.objects.map(String))]
        : [];
      const mediaRoot = `episodes/${episodeId}/`;
      const isUploadPath = (key: string) => key === bodyPath(episodeId)
        || key.startsWith(`${mediaRoot}image-`)
        || key.startsWith(`${mediaRoot}audio-`);
      if (!technicalIdPattern.test(episodeId)
        || !objects.length
        || objects.some((key) => !validEpisodeKey(key, episodeId) || !isUploadPath(key))) {
        return json(req, { error: "Nettoyage upload invalide." }, 400);
      }
      // Une sauvegarde peut avoir abouti côté serveur malgré une réponse réseau perdue.
      // Ne jamais supprimer un objet désormais référencé par l'épisode.
      const { data: episode, error: episodeError } = await supabase.from("episodes")
        .select("storage_provider,data").eq("id", episodeId).maybeSingle();
      if (episodeError) throw episodeError;
      const referenced = new Set<string>();
      if (episode?.data && episode.storage_provider === provider) {
        const savedData = normalizeMediaData(episode.data, episodeId, episode.data.youtube ?? null);
        for (const item of mediaItems(savedData)) referenced.add(item.key);
      }
      const removable = objects.filter((key) => !referenced.has(key));
      await deleteObjects(supabase, provider, removable);
      return json(req, { ok: true, removed: removable.length });
    }

    if (payload.action === "save") {
      const incoming = payload.episode as Record<string, unknown>;
      if (!incoming || !validBaseEpisode(incoming)) return json(req, { error: "Épisode invalide." }, 400);
      const episodeId = String(incoming.id);
      const provider = incoming.storage_provider === "r2" ? "r2" : "supabase";
      const rawData = (incoming.data && typeof incoming.data === "object" ? incoming.data : {}) as Record<string, unknown>;
      const rawYoutube = rawData.youtube ? String(rawData.youtube) : "";
      const youtube = youtubeVideoId(rawYoutube);
      if (rawYoutube && !youtube) return json(req, { error: "Lien ou identifiant YouTube invalide." }, 400);

      const { data: previous, error: previousError } = await supabase.from("episodes")
        .select("id,share_id,number,token,storage_provider,data")
        .eq("id", episodeId).maybeSingle();
      if (previousError) throw previousError;
      const shareId = String(incoming.share_id ?? previous?.share_id ?? "");
      const number = Number(incoming.number ?? previous?.number);
      if (!shareIdPattern.test(shareId) || !Number.isInteger(number) || number < 1) {
        return json(req, { error: "Identifiant court ou numéro invalide." }, 400);
      }

      let data: MediaData;
      if (provider === "supabase") {
        const markdown = String(payload.body ?? "");
        const path = bodyPath(episodeId);
        const previousData = previous?.data
          ? normalizeMediaData(previous.data, episodeId, previous.data.youtube ?? null)
          : null;
        const bodyChanged = payload.bodyChanged !== false
          || !previousData
          || previous?.storage_provider !== "supabase";
        const requested: MediaItem[] = [];
        let bodyItem = previousData?.body ?? null;
        if (bodyChanged) {
          const { error: bodyError } = await supabase.storage.from(SUPABASE_BUCKET).upload(
            path,
            new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
            { upsert: true, cacheControl: "120", contentType: "text/markdown;charset=utf-8" },
          );
          if (bodyError) throw bodyError;
          bodyItem = {
            key: path,
            size: new TextEncoder().encode(markdown).byteLength,
            mime: "text/markdown;charset=utf-8",
          };
          requested.push(bodyItem);
        }
        if (!bodyItem) throw new Error("Fichier body.md absent.");

        for (const kind of ["image", "audio"] as const) {
          const incomingItem = rawData[kind] as MediaItem | null | undefined;
          const previousItem = previousData?.[kind] ?? null;
          if (incomingItem && (previous?.storage_provider !== "supabase" || incomingItem.key !== previousItem?.key)) {
            requested.push(incomingItem);
          }
        }
        const actual = requested.length
          ? await supabaseObjectInfo(supabase, requested.map((item) => String(item.key)))
          : [];
        const byKey = (item: MediaItem | null) => item
          ? actual.find((candidate) => candidate.key === item.key) ?? item
          : null;
        data = normalizeMediaData({
          body: byKey(bodyItem),
          image: byKey((rawData.image as MediaItem | null) ?? null),
          audio: byKey((rawData.audio as MediaItem | null) ?? null),
        }, episodeId, youtube);
        if (requested.length) await verifySupabase(supabase, requested, actual);
      } else {
        await r2WriteContext(supabase);
        data = normalizeMediaData(incoming.data, episodeId, youtube);
        await verifyR2(supabase, mediaItems(data));
      }

      const accessToken = Object.prototype.hasOwnProperty.call(incoming, "token")
        ? incoming.token ? String(incoming.token) : null
        : previous?.token ?? null;
      const totalBytes = mediaItems(data).reduce((sum, item) => sum + item.size, 0);
      const episode = {
        id: episodeId,
        share_id: shareId,
        number,
        title: String(incoming.title).trim(),
        type: String(incoming.type),
        tags: (incoming.tags as unknown[]).map(String).filter(Boolean),
        published_on: String(incoming.published_on),
        duration: String(incoming.duration ?? ""),
        description: String(incoming.description),
        palette: Number.isInteger(incoming.palette) ? Number(incoming.palette) : 0,
        token: accessToken,
        created_at: String(incoming.created_at),
        storage_provider: provider,
        storage_bytes: totalBytes,
        data,
      };
      const { error } = await supabase.from("episodes").upsert(episode, { onConflict: "id" });
      if (error) throw error;

      if (previous?.data) {
        const oldData = normalizeMediaData(previous.data, episodeId, previous.data.youtube ?? null);
        const nextKeys = new Set(mediaItems(data).map((item) => item.key));
        const obsolete = mediaItems(oldData).map((item) => item.key).filter((key) => !nextKeys.has(key) || previous.storage_provider !== provider);
        if (obsolete.length) await deleteObjects(supabase, previous.storage_provider as Provider, obsolete);
      }
      return json(req, { ok: true, provider, data, storageBytes: totalBytes, shareId, number });
    }

    if (payload.action === "migration-start") {
      const episodeId = String(payload.episodeId ?? "");
      const target = payload.target === "supabase" ? "supabase" : "r2";
      if (!technicalIdPattern.test(episodeId)) return json(req, { error: "Épisode invalide." }, 400);
      const { data: episode, error } = await supabase.from("episodes")
        .select("id,storage_provider,storage_bytes,data").eq("id", episodeId).single();
      if (error) throw error;
      if (episode.storage_provider === target) return json(req, { error: "Épisode déjà stocké chez ce fournisseur." }, 409);
      const data = normalizeMediaData(episode.data, episodeId, episode.data.youtube ?? null);
      if (target === "supabase") {
        if (mediaItems(data).some((item) => item.size > MAX_SUPABASE_FILE_BYTES)) {
          return json(req, { error: "Retour impossible : un fichier dépasse 50 Mo." }, 400);
        }
        const config = await settings(supabase);
        const { data: used, error: usedError } = await supabase.rpc("tba_storage_bytes");
        if (usedError) throw usedError;
        const limit = config.auto_migration_enabled ? 0.75 : 0.95;
        if (Number(used) + Number(episode.storage_bytes) > Number(config.quota_bytes) * limit) {
          return json(req, { error: `Retour impossible : limite de ${Math.round(limit * 100)} % dépassée.` }, 400);
        }
      } else {
        await r2WriteContext(supabase);
      }
      const cleared = await supabase.from("tba_storage_jobs").delete()
        .eq("episode_id", episodeId).eq("status", "error");
      if (cleared.error) throw cleared.error;
      const { data: existing } = await supabase.from("tba_storage_jobs")
        .select("*").eq("episode_id", episodeId)
        .in("status", ["queued", "copying", "verifying", "committing", "cleanup"])
        .maybeSingle();
      let job = existing;
      if (!job) {
        const created = await supabase.from("tba_storage_jobs").insert({
          episode_id: episodeId,
          source_provider: episode.storage_provider,
          target_provider: target,
          status: "copying",
          manifest: data,
        }).select().single();
        if (created.error?.code === "23505") {
          const concurrent = await supabase.from("tba_storage_jobs")
            .select("*").eq("episode_id", episodeId)
            .in("status", ["queued", "copying", "verifying", "committing", "cleanup", "error"])
            .single();
          if (concurrent.error) throw created.error;
          job = concurrent.data;
        } else {
          if (created.error) throw created.error;
          job = created.data;
        }
      }
      return json(req, { job, data });
    }

    if (payload.action === "migration-finish") {
      const jobId = String(payload.jobId ?? "");
      const { data: job, error: jobError } = await supabase.from("tba_storage_jobs").select("*").eq("id", jobId).single();
      if (jobError) throw jobError;
      const data = normalizeMediaData(job.manifest, job.episode_id, job.manifest.youtube ?? null);
      const verifying = await supabase.from("tba_storage_jobs")
        .update({ status: "verifying", updated_at: new Date().toISOString() }).eq("id", jobId);
      if (verifying.error) throw verifying.error;
      if (job.target_provider === "r2") await verifyR2(supabase, mediaItems(data));
      else await verifySupabase(supabase, mediaItems(data));
      const total = mediaItems(data).reduce((sum, item) => sum + item.size, 0);
      const updated = await supabase.from("episodes").update({ storage_provider: job.target_provider, storage_bytes: total })
        .eq("id", job.episode_id).eq("storage_provider", job.source_provider);
      if (updated.error) throw updated.error;
      const cleanup = await supabase.from("tba_storage_jobs")
        .update({ status: "cleanup", updated_at: new Date().toISOString() }).eq("id", jobId);
      if (cleanup.error) throw cleanup.error;
      await deleteObjects(supabase, job.source_provider, mediaItems(data).map((item) => item.key));
      const removed = await supabase.from("tba_storage_jobs").delete().eq("episode_id", job.episode_id);
      if (removed.error) throw removed.error;
      return json(req, { ok: true, provider: job.target_provider, data, storageBytes: total });
    }

    if (payload.action === "migration-error") {
      const { error } = await supabase.from("tba_storage_jobs").update({
        status: "error",
        error: String(payload.error ?? "Migration interrompue.").slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq("id", String(payload.jobId ?? ""));
      if (error) throw error;
      return json(req, { ok: true });
    }

    if (payload.action === "delete") {
      const id = String(payload.id ?? "");
      if (!technicalIdPattern.test(id)) return json(req, { error: "Identifiant invalide." }, 400);
      const { data: episode, error: findError } = await supabase.from("episodes")
        .select("storage_provider,data").eq("id", id).maybeSingle();
      if (findError) throw findError;
      if (!episode) return json(req, { error: "Épisode introuvable." }, 404);
      const data = normalizeMediaData(episode.data, id, episode.data.youtube ?? null);
      await deleteObjects(supabase, episode.storage_provider, mediaItems(data).map((item) => item.key));
      const { error } = await supabase.from("episodes").delete().eq("id", id);
      if (error) throw error;
      return json(req, { ok: true });
    }

    if (payload.action === "renumber") {
      const { data, error } = await supabase.rpc("renumber_tba_episodes");
      if (error) throw error;
      return json(req, { ok: true, count: data ?? 0 });
    }

    return json(req, { error: "Action inconnue." }, 400);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "Erreur serveur.";
    return json(req, { error: message }, 500);
  }
});
