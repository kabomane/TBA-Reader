export const DEFAULT_WHISPER_MODEL_KEY = "base";

export const WHISPER_MODELS = Object.freeze({
  tiny: Object.freeze({
    key: "tiny",
    id: "whisper-tiny-q5_1-fr-v1",
    name: "Tiny Q5_1",
    qualifier: "rapide",
    bytes: 32_152_673,
    sha256: "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
    path: "/whisper/ggml-tiny-q5_1.bin",
  }),
  base: Object.freeze({
    key: "base",
    id: "whisper-base-q5_1-fr-v1",
    name: "Base Q5_1",
    qualifier: "précis",
    bytes: 59_707_625,
    sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
    path: "/whisper/ggml-base-q5_1.bin",
  }),
});

export const WHISPER_MODEL_KEYS = Object.freeze(Object.keys(WHISPER_MODELS));

// Alias Base conservés pour les anciens appels et caches.
export const WHISPER_MODEL_ID = WHISPER_MODELS.base.id;
export const WHISPER_MODEL_BYTES = WHISPER_MODELS.base.bytes;
export const WHISPER_MODEL_SHA256 = WHISPER_MODELS.base.sha256;
