import { createSignal } from 'solid-js';

// ---- Mic (STT) State ----

export type MicStatus = 'off' | 'listening' | 'paused';

const [micStatus, setMicStatus] = createSignal<MicStatus>('off');
const [micMuted, setMicMuted] = createSignal(false);

export { micStatus, setMicStatus, micMuted, setMicMuted };

// ---- Speaker (TTS) State ----

export type SpeakerStatus = 'off' | 'playing';

const [speakerStatus, setSpeakerStatus] = createSignal<SpeakerStatus>('off');
const [speakerMuted, setSpeakerMuted] = createSignal(false);

export { speakerStatus, setSpeakerStatus, speakerMuted, setSpeakerMuted };

// ---- Live Transcription ----

const [speechPartialText, setSpeechPartialText] = createSignal('');

export { speechPartialText, setSpeechPartialText };
