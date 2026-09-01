'use strict';

let instance = null;
let runtimeReady = false;
let pendingModel = null;
let processing = false;

function send(type, data) {
  self.postMessage(Object.assign({ type }, data || {}));
}

function describeError(error) {
  if (!error) return 'Erreur inconnue';
  if (typeof error === 'string') return error;
  return error.message || error.reason || String(error);
}

function enginePrint(value) {
  const line = String(value || '');
  send('log', { line });
  const segment = line.match(/^\s*\[[^\]]+--\>[^\]]+\]\s*(.+?)\s*$/);
  if (segment && segment[1] && segment[1] !== '[BLANK_AUDIO]') {
    send('segment', { text: segment[1] });
  }
  if (processing && /whisper_print_timings:.*total time/i.test(line)) {
    processing = false;
    send('chunk-complete');
  }
}

var Module = {
  print: enginePrint,
  printErr: enginePrint,
  setStatus() {},
  monitorRunDependencies() {},
  onRuntimeInitialized() {
    runtimeReady = true;
    send('runtime-ready');
    if (pendingModel) initializeModel(pendingModel);
  }
};

function initializeModel(buffer) {
  if (!runtimeReady) {
    pendingModel = buffer;
    return;
  }
  pendingModel = null;
  try {
    const bytes = new Uint8Array(buffer);
    try {
      Module.FS_unlink('whisper.bin');
    } catch (_) {
      // Premier chargement du modèle dans le système de fichiers WASM.
    }
    Module.FS_createDataFile('/', 'whisper.bin', bytes, true, true);
    instance = Module.init('whisper.bin');
    if (!instance) throw new Error('Whisper n’a pas pu initialiser le modèle.');
    send('model-ready', { bytes: bytes.length });
  } catch (error) {
    send('error', { message: describeError(error) });
  }
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === 'init-model') {
    initializeModel(message.model);
    return;
  }
  if (message.type !== 'transcribe') return;
  if (!instance) {
    send('error', { message: 'Le modèle Whisper n’est pas initialisé.' });
    return;
  }
  if (processing) {
    send('error', { message: 'Whisper traite déjà un bloc audio.' });
    return;
  }
  try {
    const audio = new Float32Array(message.audio);
    processing = true;
    const result = Module.full_default(instance, audio, 'fr', message.threads || 2, false);
    if (result !== 0) {
      processing = false;
      throw new Error(`Whisper a retourné le code ${result}.`);
    }
  } catch (error) {
    processing = false;
    send('error', { message: describeError(error) });
  }
};

self.addEventListener('error', event => {
  send('error', { message: `Worker : ${describeError(event)}` });
});

self.addEventListener('unhandledrejection', event => {
  send('error', { message: `Promesse rejetée : ${describeError(event.reason)}` });
});

try {
  importScripts('/whisper/whisper-engine.js');
} catch (error) {
  send('error', { message: `Chargement du moteur : ${describeError(error)}` });
}
