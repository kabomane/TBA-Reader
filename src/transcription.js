import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WHISPER_MODEL_BYTES, WHISPER_MODEL_ID, WHISPER_MODEL_SHA256 } from "./whisperConfig.js";

const DB_NAME = "tba-reader-whisper-v1";
const DB_VERSION = 1;
const MODEL_STORE = "models";
const TRANSCRIPT_STORE = "transcripts";
const MODEL_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const WORKER_URL = "/whisper/whisper-worker.js";
const CHUNK_SECONDS = 30;
const CHUNK_TIMEOUT_MS = 10 * 60 * 1000;
const TARGET_SAMPLE_RATE = 16000;

let databasePromise = null;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(MODEL_STORE)) database.createObjectStore(MODEL_STORE, { keyPath: "id" });
        if (!database.objectStoreNames.contains(TRANSCRIPT_STORE)) database.createObjectStore(TRANSCRIPT_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB indisponible."));
      request.onblocked = () => reject(new Error("IndexedDB est bloqué par un autre onglet."));
    });
  }
  return databasePromise;
}

async function readRecord(storeName, id) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeRecord(storeName, value) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Écriture IndexedDB annulée."));
  });
}

async function deleteRecord(storeName, id) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function readModelCache() {
  try {
    const cached = await readRecord(MODEL_STORE, WHISPER_MODEL_ID);
    return cached?.sha256 === WHISPER_MODEL_SHA256 && cached.blob instanceof Blob ? cached : null;
  } catch {
    return null;
  }
}

export async function hasCachedWhisperModel() {
  return Boolean(await readModelCache());
}

async function downloadModel(modelUrl, signal, onProgress) {
  const response = await fetch(modelUrl, { signal, cache: "no-store", mode: "cors" });
  if (!response.ok) throw new Error(`Modèle Whisper indisponible (${response.status}).`);
  const total = Number(response.headers.get("content-length")) || WHISPER_MODEL_BYTES;
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.(1);
    return bytes;
  }
  const chunks = [];
  let received = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    received += result.value.byteLength;
    onProgress?.(total ? received / total : 0);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength !== WHISPER_MODEL_BYTES) throw new Error("Le modèle Whisper téléchargé est incomplet.");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (checksum !== WHISPER_MODEL_SHA256) throw new Error("Le modèle Whisper téléchargé est corrompu.");
  return bytes;
}

async function loadModel(modelUrl, signal, onProgress) {
  const cached = await readModelCache();
  const cacheFresh = cached && Number.isFinite(cached.checkedAt) && Date.now() - cached.checkedAt < MODEL_REFRESH_MS;
  if (cacheFresh) {
    onProgress?.(1);
    return cached.blob.arrayBuffer();
  }

  if (cached && cached.blob.size === WHISPER_MODEL_BYTES) {
    const refreshed = { ...cached, checkedAt: Date.now() };
    await writeRecord(MODEL_STORE, refreshed).catch(() => {});
    onProgress?.(1);
    return cached.blob.arrayBuffer();
  }

  if (!modelUrl) throw new Error("Adresse publique du modèle Whisper absente.");
  const bytes = await downloadModel(modelUrl, signal, onProgress);
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  await writeRecord(MODEL_STORE, {
    id: WHISPER_MODEL_ID,
    sha256: WHISPER_MODEL_SHA256,
    blob,
    savedAt: Date.now(),
    checkedAt: Date.now(),
  }).catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
  return bytes.buffer;
}

function transcriptId(episode) {
  const audio = episode.storageData?.audio || {};
  const identity = audio.key || episode.audioPath || episode.audio || "audio";
  return ["transcript", episode.uid || episode.id, identity, audio.etag || audio.size || "", WHISPER_MODEL_SHA256].join(":");
}

async function readTranscript(episode) {
  try {
    const record = await readRecord(TRANSCRIPT_STORE, transcriptId(episode));
    if (record?.model !== WHISPER_MODEL_SHA256) return null;
    if (Array.isArray(record.blocks)) {
      return {
        blocks: record.blocks.map((block) => String(block || "")),
        nextChunk: Number.isInteger(record.nextChunk) && record.nextChunk > 0 ? record.nextChunk : 0,
        complete: Boolean(record.complete),
      };
    }
    if (typeof record.text === "string") {
      return {
        blocks: record.text.split(/\n{2,}/).filter(Boolean),
        nextChunk: 0,
        complete: true,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function saveTranscript(episode, blocks, nextChunk, complete = false) {
  await writeRecord(TRANSCRIPT_STORE, {
    id: transcriptId(episode),
    model: WHISPER_MODEL_SHA256,
    blocks: [...blocks],
    nextChunk,
    complete,
    text: blocks.filter(Boolean).join("\n\n").trim(),
    savedAt: Date.now(),
  }).catch(() => {});
}

async function removeTranscript(episode) {
  await deleteRecord(TRANSCRIPT_STORE, transcriptId(episode)).catch(() => {});
}

function resampleChunk(buffer, startSeconds, endSeconds) {
  const sourceRate = buffer.sampleRate;
  const sourceStart = Math.floor(startSeconds * sourceRate);
  const sourceEnd = Math.min(buffer.length, Math.ceil(endSeconds * sourceRate));
  const sourceLength = Math.max(0, sourceEnd - sourceStart);
  const outputLength = Math.max(1, Math.floor(sourceLength * TARGET_SAMPLE_RATE / sourceRate));
  const output = new Float32Array(outputLength);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index += 1) {
    const position = sourceStart + index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, sourceEnd - 1);
    const fraction = position - left;
    let sample = 0;
    for (const channel of channels) sample += channel[left] + (channel[right] - channel[left]) * fraction;
    output[index] = sample / channels.length;
  }
  return output;
}

function statusLabel(status, progress, chunk, totalChunks) {
  if (status === "cache") return "Lecture du cache…";
  if (status === "loading") return progress > 0 && progress < 1 ? `Chargement du modèle · ${Math.round(progress * 100)} %` : "Préparation du modèle et de l’audio…";
  if (status === "transcribing") return `Transcription · bloc ${Math.min(chunk + 1, totalChunks)}/${totalChunks}`;
  if (status === "stopped") return "Transcription arrêtée";
  if (status === "complete") return "Transcription terminée";
  if (status === "error") return "Transcription impossible";
  return "";
}

export function useLocalTranscription(episode, active, modelUrl = "") {
  const [status, setStatus] = useState("idle");
  const [blocks, setBlocks] = useState([]);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [chunk, setChunk] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const workerRef = useRef(null);
  const abortRef = useRef(null);
  const audioContextRef = useRef(null);
  const runRef = useRef(0);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    context?.close?.().catch(() => {});
  }, []);

  const stop = useCallback(() => {
    runRef.current += 1;
    cleanup();
    setStatus("stopped");
    setError("");
  }, [cleanup]);

  const start = useCallback(async ({ force = false } = {}) => {
    if (!active || !episode?.audio) return;
    const run = runRef.current + 1;
    runRef.current = run;
    cleanup();
    setError("");
    setProgress(0);
    setChunk(0);
    setTotalChunks(0);
    if (force) {
      setBlocks([]);
      await removeTranscript(episode);
    }
    setStatus("cache");

    let cachedTranscript = null;
    if (!force) {
      cachedTranscript = await readTranscript(episode);
      if (runRef.current !== run) return;
      if (cachedTranscript) {
        setBlocks(cachedTranscript.blocks.filter(Boolean));
      }
      if (cachedTranscript?.complete) {
        setStatus("complete");
        return;
      }
    }

    if (!window.crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
      setStatus("error");
      setError("Ce navigateur n’active pas l’isolation nécessaire à Whisper.");
      return;
    }

    if (!cachedTranscript) setBlocks([]);
    setStatus("loading");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Décodage audio indisponible dans ce navigateur.");
      const context = new AudioContextClass();
      audioContextRef.current = context;

      const modelPromise = loadModel(modelUrl, controller.signal, (nextProgress) => {
        if (runRef.current === run) setProgress(nextProgress);
      });
      const audioPromise = fetch(episode.audio, { signal: controller.signal, mode: "cors" })
        .then((response) => {
          if (!response.ok) throw new Error(`Audio indisponible (${response.status}).`);
          return response.arrayBuffer();
        })
        .then((audioBytes) => context.decodeAudioData(audioBytes.slice(0)));

      const [model, decodedAudio] = await Promise.all([modelPromise, audioPromise]);
      if (runRef.current !== run) return;
      await context.close().catch(() => {});
      audioContextRef.current = null;

      const chunks = Math.max(1, Math.ceil(decodedAudio.duration / CHUNK_SECONDS));
      setTotalChunks(chunks);
      setStatus("transcribing");

      const worker = new Worker(WORKER_URL, { name: "tba-whisper" });
      workerRef.current = worker;
      let currentChunk = Math.min(cachedTranscript?.nextChunk || 0, chunks);
      let currentText = [];
      const completedChunkTexts = Array.from(
        { length: currentChunk },
        (_, index) => cachedTranscript?.blocks[index] || "",
      );
      let transcriptSave = Promise.resolve();
      let lastWorkerLog = "";
      setChunk(currentChunk);
      setBlocks(completedChunkTexts.filter(Boolean));

      await new Promise((resolve, reject) => {
        let chunkTimeout = null;

        const clearChunkTimeout = () => {
          if (chunkTimeout !== null) window.clearTimeout(chunkTimeout);
          chunkTimeout = null;
        };

        const rejectChunkTimeout = () => {
          const diagnostic = lastWorkerLog ? ` Dernier message : ${lastWorkerLog}` : "";
          reject(new Error(`Le bloc ${currentChunk + 1}/${chunks} ne répond plus depuis 10 minutes.${diagnostic}`));
        };

        controller.signal.addEventListener("abort", () => {
          clearChunkTimeout();
          reject(new DOMException("Transcription arrêtée.", "AbortError"));
        }, { once: true });

        const sendChunk = () => {
          if (runRef.current !== run) return;
          if (currentChunk >= chunks) {
            clearChunkTimeout();
            resolve();
            return;
          }
          setChunk(currentChunk);
          const startSeconds = currentChunk * CHUNK_SECONDS;
          const endSeconds = Math.min(decodedAudio.duration, startSeconds + CHUNK_SECONDS);
          const pcm = resampleChunk(decodedAudio, startSeconds, endSeconds);
          const threads = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
          worker.postMessage({ type: "transcribe", audio: pcm.buffer, threads }, [pcm.buffer]);
          clearChunkTimeout();
          chunkTimeout = window.setTimeout(rejectChunkTimeout, CHUNK_TIMEOUT_MS);
        };

        worker.onerror = event => {
          clearChunkTimeout();
          const location = event.filename ? `${event.filename}${event.lineno ? `:${event.lineno}` : ""}` : "";
          const details = [event.message, location].filter(Boolean).join(" — ");
          reject(new Error(details ? `Worker Whisper : ${details}` : "Le Worker Whisper n’a pas pu démarrer. Vérifiez l’isolation WebAssembly."));
        };
        worker.onmessage = event => {
          const message = event.data || {};
          if (message.type === "model-ready") {
            sendChunk();
          } else if (message.type === "segment") {
            const text = String(message.text || "").trim();
            if (text) {
              currentText.push(text);
              setBlocks([...completedChunkTexts.filter(Boolean), currentText.join(" ")]);
            }
          } else if (message.type === "log") {
            lastWorkerLog = String(message.line || "").trim();
          } else if (message.type === "chunk-complete") {
            clearChunkTimeout();
            const text = currentText.join(" ").trim();
            completedChunkTexts[currentChunk] = text;
            currentText = [];
            currentChunk += 1;
            setBlocks(completedChunkTexts.filter(Boolean));
            const snapshot = [...completedChunkTexts];
            const savedNextChunk = currentChunk;
            transcriptSave = transcriptSave.then(() => saveTranscript(episode, snapshot, savedNextChunk, savedNextChunk >= chunks));
            window.setTimeout(sendChunk, 0);
          } else if (message.type === "error") {
            clearChunkTimeout();
            reject(new Error(message.message || "Erreur du moteur Whisper."));
          }
        };
        worker.postMessage({ type: "init-model", model }, [model]);
      });

      if (runRef.current !== run) return;
      worker.terminate();
      workerRef.current = null;
      abortRef.current = null;
      await transcriptSave;
      await saveTranscript(episode, completedChunkTexts, chunks, true);
      if (runRef.current === run) {
        setChunk(chunks);
        setStatus("complete");
      }
    } catch (nextError) {
      if (runRef.current !== run || nextError?.name === "AbortError") return;
      cleanup();
      setStatus("error");
      setError(nextError?.message || "Transcription impossible.");
    }
  }, [active, cleanup, episode, modelUrl]);

  useEffect(() => () => {
    runRef.current += 1;
    cleanup();
  }, [cleanup]);

  const busy = ["cache", "loading", "transcribing"].includes(status);
  const buttonLabel = ["complete", "stopped", "error"].includes(status) ? "Relire" : "Lire";
  const label = useMemo(() => statusLabel(status, progress, chunk, totalChunks), [chunk, progress, status, totalChunks]);
  const emptyText = error || (status === "complete" ? "Aucun texte reconnu." : status === "stopped" ? "Transcription arrêtée." : status === "transcribing" ? "Analyse du bloc en cours…" : "Préparation de la transcription…");

  return {
    blocks,
    busy,
    buttonLabel,
    error,
    emptyText,
    label,
    start: () => start({ force: status !== "idle" }),
    stop,
  };
}
