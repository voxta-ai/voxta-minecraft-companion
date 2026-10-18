import { createSignal } from 'solid-js';

const STORAGE_KEY = 'voxta-mc-audio';

interface AudioPrefs {
    micMuted: boolean;
    speakerMuted: boolean;
    /** Chosen microphone (MediaDeviceInfo.deviceId); null follows the system default. */
    micDeviceId?: string | null;
    /** Chosen speaker for the companion's voice; null follows the system default. */
    speakerDeviceId?: string | null;
}

function loadAudioPrefs(): AudioPrefs {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch {
        /* ignore */
    }
    return { micMuted: false, speakerMuted: false };
}

function saveAudioPrefs(prefs: AudioPrefs): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

// ---- Mic (STT) State ----

export type MicStatus = 'off' | 'listening' | 'active' | 'paused';

const savedPrefs = loadAudioPrefs();
const [micStatus, setMicStatus] = createSignal<MicStatus>('off');
const [micMuted, setMicMutedRaw] = createSignal(savedPrefs.micMuted);
const [micDeviceId, setMicDeviceIdRaw] = createSignal<string | null>(savedPrefs.micDeviceId ?? null);

function persistAudioPrefs(): void {
    saveAudioPrefs({
        micMuted: micMuted(),
        speakerMuted: speakerMuted(),
        micDeviceId: micDeviceId(),
        speakerDeviceId: speakerDeviceId(),
    });
}

function setMicMuted(value: boolean): void {
    setMicMutedRaw(value);
    persistAudioPrefs();
}

function setMicDeviceId(value: string | null): void {
    setMicDeviceIdRaw(value);
    persistAudioPrefs();
}

export { micStatus, setMicStatus, micMuted, setMicMuted, micDeviceId, setMicDeviceId };

// ---- Speaker (TTS) State ----

export type SpeakerStatus = 'off' | 'playing';

const [speakerStatus, setSpeakerStatus] = createSignal<SpeakerStatus>('off');
const [speakerMuted, setSpeakerMutedRaw] = createSignal(savedPrefs.speakerMuted);
const [speakerDeviceId, setSpeakerDeviceIdRaw] = createSignal<string | null>(savedPrefs.speakerDeviceId ?? null);

function setSpeakerMuted(value: boolean): void {
    setSpeakerMutedRaw(value);
    persistAudioPrefs();
}

function setSpeakerDeviceId(value: string | null): void {
    setSpeakerDeviceIdRaw(value);
    persistAudioPrefs();
}

export { speakerStatus, setSpeakerStatus, speakerMuted, setSpeakerMuted, speakerDeviceId, setSpeakerDeviceId };

// ---- Live Transcription ----

const [speechPartialText, setSpeechPartialText] = createSignal('');

export { speechPartialText, setSpeechPartialText };
