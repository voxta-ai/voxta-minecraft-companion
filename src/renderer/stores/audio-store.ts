import { createSignal } from 'solid-js';

const STORAGE_KEY = 'voxta-mc-audio';

function loadAudioPrefs(): { micMuted: boolean; speakerMuted: boolean } {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch {
        /* ignore */
    }
    return { micMuted: false, speakerMuted: false };
}

function saveAudioPrefs(prefs: { micMuted: boolean; speakerMuted: boolean }): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

// ---- Mic (STT) State ----

export type MicStatus = 'off' | 'listening' | 'active' | 'paused';

const savedPrefs = loadAudioPrefs();
const [micStatus, setMicStatus] = createSignal<MicStatus>('off');
const [micMuted, setMicMutedRaw] = createSignal(savedPrefs.micMuted);

function setMicMuted(value: boolean): void {
    setMicMutedRaw(value);
    saveAudioPrefs({ micMuted: value, speakerMuted: speakerMuted() });
}

export { micStatus, setMicStatus, micMuted, setMicMuted };

// ---- Speaker (TTS) State ----

export type SpeakerStatus = 'off' | 'playing';

const [speakerStatus, setSpeakerStatus] = createSignal<SpeakerStatus>('off');
const [speakerMuted, setSpeakerMutedRaw] = createSignal(savedPrefs.speakerMuted);

function setSpeakerMuted(value: boolean): void {
    setSpeakerMutedRaw(value);
    saveAudioPrefs({ micMuted: micMuted(), speakerMuted: value });
}

export { speakerStatus, setSpeakerStatus, speakerMuted, setSpeakerMuted };

// ---- Live Transcription ----

const [speechPartialText, setSpeechPartialText] = createSignal('');

export { speechPartialText, setSpeechPartialText };
