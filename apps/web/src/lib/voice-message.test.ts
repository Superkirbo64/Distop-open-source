import assert from "node:assert/strict";
import test from "node:test";
import {
  audioExtension,
  audioWaveform,
  baseAudioMime,
  chooseVoiceMessageMime,
  formatVoiceMessageTime,
  pushWaveSample,
  waveHeight,
  WAVE_BARS,
} from "./voice-message.ts";

test("elige el primer formato de grabación compatible", () => {
  assert.equal(chooseVoiceMessageMime((mime) => mime === "audio/ogg;codecs=opus"), "audio/ogg;codecs=opus");
  assert.equal(chooseVoiceMessageMime(() => false), undefined);
});

test("normaliza el tipo y la extensión de cada contenedor", () => {
  assert.equal(baseAudioMime("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(baseAudioMime(" AUDIO/MP4 ; codecs=mp4a.40.2"), "audio/mp4");
  assert.equal(baseAudioMime("application/octet-stream"), "audio/webm");
  assert.equal(audioExtension("audio/ogg;codecs=opus"), "ogg");
  assert.equal(audioExtension("audio/mp4"), "m4a");
  assert.equal(audioExtension("audio/webm"), "webm");
});

test("formatea el contador sin redondear segundos incompletos", () => {
  assert.equal(formatVoiceMessageTime(0), "0:00");
  assert.equal(formatVoiceMessageTime(9_999), "0:09");
  assert.equal(formatVoiceMessageTime(61_000), "1:01");
});

test("el rastro avanza y nunca crece más de la cuenta", () => {
  let barras: number[] = [];
  for (let i = 0; i < WAVE_BARS + 20; i++) barras = pushWaveSample(barras, i / 100);
  assert.equal(barras.length, WAVE_BARS);
  assert.ok(barras[barras.length - 1]! > barras[0]!, "la muestra nueva entra por la derecha");
  assert.deepEqual(pushWaveSample([], 5), [1], "un nivel imposible se recorta, no se dibuja fuera");
  assert.deepEqual(pushWaveSample([], Number.NaN), [0]);
});

test("en silencio la barra sigue viéndose", () => {
  assert.ok(waveHeight(0) > 0, "altura cero se leería como colgado, no como callado");
  assert.equal(waveHeight(1), 1);
  assert.ok(waveHeight(0.04) > 0.04, "los niveles bajos se levantan para que se note que graba");
});

test("la onda de reproducción representa los tramos del audio real", () => {
  const channel = new Float32Array(400);
  channel.fill(0.02, 0, 100);
  channel.fill(0.3, 100, 200);
  channel.fill(0, 200, 300);
  channel.fill(0.8, 300, 400);
  const wave = audioWaveform([channel], 4);
  assert.equal(wave.length, 4);
  assert.ok(wave[0]! < wave[1]!, "la voz más fuerte produce una barra mayor");
  assert.equal(wave[2], 0.16, "el silencio queda visible pero bajo");
  assert.equal(wave[3], 1, "el tramo más fuerte normaliza la onda");
});
