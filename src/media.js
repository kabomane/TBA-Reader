function fourCC(bytes, offset) {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

async function readBoxHeader(file, offset) {
  const bytes = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
  if (bytes.length < 8) throw new Error("Fichier M4A incomplet ou invalide.");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(0);
  const type = fourCC(bytes, 4);
  let headerSize = 8;
  if (size === 1) {
    if (bytes.length < 16) throw new Error("Fichier M4A incomplet ou invalide.");
    size = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
    headerSize = 16;
  } else if (size === 0) {
    size = file.size - offset;
  }
  if (!Number.isSafeInteger(size) || size < headerSize || offset + size > file.size) {
    throw new Error("Fichier M4A incomplet ou invalide.");
  }
  return { type, size, headerSize };
}

async function readM4aSampleEntry(file) {
  let offset = 0;
  let moov;
  while (offset < file.size) {
    const box = await readBoxHeader(file, offset);
    if (box.type === "moov") {
      moov = new Uint8Array(await file.slice(offset + box.headerSize, offset + box.size).arrayBuffer());
      break;
    }
    offset += box.size;
  }
  if (!moov) throw new Error("Métadonnées M4A introuvables.");
  for (let index = 4; index + 20 <= moov.length; index += 1) {
    if (fourCC(moov, index) !== "stsd") continue;
    const boxSize = new DataView(moov.buffer, moov.byteOffset + index - 4, 4).getUint32(0);
    if (boxSize < 20 || index - 4 + boxSize > moov.length) continue;
    return fourCC(moov, index + 16);
  }
  throw new Error("Codec M4A introuvable.");
}

export async function validateAudioFile(file) {
  if (!file) return;
  const isM4a = /\.m4a$/i.test(file.name || "") || /^(audio\/mp4|audio\/x-m4a)$/i.test(file.type || "");
  if (!isM4a) return;
  let codec;
  try {
    codec = await readM4aSampleEntry(file);
  } catch {
    throw new Error("Impossible de vérifier ce fichier M4A. Exporte-le en M4A AAC-LC ou en MP3 avant publication.");
  }
  if (codec === "mp4a") return;
  if (codec === "alac") {
    throw new Error("Ce fichier M4A utilise ALAC (Apple Lossless), non compatible avec les navigateurs. Exporte-le en M4A AAC-LC ou en MP3.");
  }
  throw new Error(`Ce fichier M4A utilise le codec ${codec}, non compatible avec les navigateurs. Exporte-le en M4A AAC-LC ou en MP3.`);
}
