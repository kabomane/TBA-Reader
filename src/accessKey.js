export const ACCESS_KEY_LENGTH = 9;
export const ACCESS_KEY_PATTERN = /^[A-Z]{3}-[A-Z0-9]{4}-[0-9]{2}$/;
export const ACCESS_TOKEN_PATTERN = /^[0-9a-f]{16}$/;
export const ACCESS_TOKEN_STORAGE_KEY = "tba-access-token-v1";

function ruleAt(index) {
  if (index < 3) return /[A-Z]/;
  if (index < 7) return /[A-Z0-9]/;
  return /[0-9]/;
}

export function accessKeyRaw(value = "") {
  let raw = "";

  for (const character of String(value).toUpperCase()) {
    if (raw.length >= ACCESS_KEY_LENGTH) break;
    if (ruleAt(raw.length).test(character)) raw += character;
  }

  return raw;
}

export function formatAccessKey(value = "") {
  const raw = accessKeyRaw(value);
  let formatted = raw.slice(0, 3);

  if (raw.length >= 3) formatted += "-";
  formatted += raw.slice(3, 7);
  if (raw.length >= 7) formatted += "-";
  formatted += raw.slice(7, 9);

  return formatted;
}

export function isValidAccessKey(value = "") {
  return ACCESS_KEY_PATTERN.test(formatAccessKey(value));
}

export async function hashAccessKey(value) {
  const formatted = formatAccessKey(value);
  if (!isValidAccessKey(formatted)) throw new Error("Clé d’accès incomplète.");

  const bytes = new TextEncoder().encode(formatted);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function readAccessToken() {
  try {
    const token = localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) ?? "";
    if (ACCESS_TOKEN_PATTERN.test(token)) return token;
    localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    // L’application reste publique si le stockage local est indisponible.
  }
  return "";
}

export function storeAccessToken(token = "") {
  try {
    if (ACCESS_TOKEN_PATTERN.test(token)) {
      localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    }
  } catch {
    // La clé reste active pour la session React même si localStorage est indisponible.
  }
}

export function filterEpisodesByAccess(episodes, accessToken = "") {
  return episodes.filter((episode) => !episode.token || episode.token === accessToken);
}
