import { desktopCapturer } from 'electron';
import type { VisionMode } from '../shared/ipc-types';

/**
 * Handles Voxta vision capture requests by screenshotting a Minecraft window
 * and POSTing the image back to Voxta's vision API.
 *
 * Supports two modes:
 *  - "screen":  captures the user's own Minecraft window (source=Screen)
 *  - "eyes":    captures the spectator/bot-camera window (source=Eyes)
 */

interface VisionCaptureRequest {
    sessionId: string;
    visionCaptureRequestId: string;
    source: string;
}

// ---- Window selection state for "eyes" mode ----
let preferredWindowIndex = -1; // -1 = auto (pick last)

/**
 * Get all Minecraft game windows (excluding the launcher and companion app).
 */
async function getMinecraftWindows(): Promise<Electron.DesktopCapturerSource[]> {
    const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1024, height: 768 },
    });

    return sources.filter((s) => {
        const name = s.name.toLowerCase();
        return name.startsWith('minecraft') && !name.includes('companion') && !name.includes('voxta') && !name.includes('launcher');
    });
}

/**
 * Cycle through available Minecraft windows for "eyes" mode.
 * Returns the name of the newly selected window, or null if none found.
 */
export async function cycleVisionWindow(): Promise<string | null> {
    const windows = await getMinecraftWindows();
    if (windows.length === 0) return null;

    // Advance to the next window
    preferredWindowIndex = (preferredWindowIndex + 1) % windows.length;
    const selected = windows[preferredWindowIndex];
    console.log(`[Vision] Switched to window ${preferredWindowIndex + 1}/${windows.length}: "${selected.name}"`);
    return `Window ${preferredWindowIndex + 1}/${windows.length}: ${selected.name}`;
}

/**
 * Capture a Minecraft window screenshot.
 *
 * - "screen" mode: picks the first game window (the user's own client)
 * - "eyes" mode: picks by preferredWindowIndex (default: last = spectator)
 */
async function captureMinecraftWindow(mode: VisionMode): Promise<Buffer | null> {
    const mcWindows = await getMinecraftWindows();

    if (mcWindows.length === 0) {
        console.warn('[Vision] No Minecraft game window found');
        return null;
    }

    let mcSource: Electron.DesktopCapturerSource;

    if (mode === 'screen') {
        // Screen mode: pick the first game window (user's own Minecraft)
        mcSource = mcWindows[0];
    } else {
        // Eyes mode: use preferred index, default to last window (spectator launched second)
        const idx = preferredWindowIndex >= 0 && preferredWindowIndex < mcWindows.length
            ? preferredWindowIndex
            : mcWindows.length - 1;
        mcSource = mcWindows[idx];
    }

    const thumbnail = mcSource.thumbnail;
    if (thumbnail.isEmpty()) {
        console.warn('[Vision] Captured thumbnail is empty');
        return null;
    }

    return thumbnail.toJPEG(85);
}

/**
 * Handle a vision capture request from Voxta:
 * 1. Capture the Minecraft window
 * 2. POST the image to Voxta's vision API
 * 3. If capture fails, cancel the request so Voxta doesn't hang
 */
export async function handleVisionCaptureRequest(
    request: VisionCaptureRequest,
    baseUrl: string,
    apiKey: string | null,
    mode: VisionMode,
): Promise<void> {
    const { sessionId, visionCaptureRequestId } = request;

    const headers: Record<string, string> = {};
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Map mode to Voxta's ComputerVisionSource
    const visionSource = mode === 'eyes' ? 'Eyes' : 'Screen';

    try {
        const imageBuffer = await captureMinecraftWindow(mode);

        if (!imageBuffer) {
            console.warn('[Vision] No Minecraft window found \u2014 canceling vision request');
            await cancelVisionRequest(baseUrl, sessionId, visionCaptureRequestId, headers);
            return;
        }

        // POST the image as multipart/form-data
        const blob = new Blob([new Uint8Array(imageBuffer)], { type: 'image/jpeg' });
        const formData = new FormData();
        formData.append('file', blob, 'minecraft.jpg');

        const url = `${baseUrl}/api/vision/requests/${visionCaptureRequestId}/send?sessionId=${sessionId}&source=${visionSource}&label=minecraft`;

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: formData,
        });

        if (!response.ok) {
            console.error(`[Vision] Failed to send screenshot: ${response.status} ${response.statusText}`);
            const text = await response.text().catch(() => '');
            if (text) console.error(`[Vision] Response: ${text}`);
        }
    } catch (err) {
        console.error('[Vision] Error during capture:', err);
        try {
            await cancelVisionRequest(baseUrl, sessionId, visionCaptureRequestId, headers);
        } catch {
            // Suppress cancel failure
        }
    }
}

async function cancelVisionRequest(
    baseUrl: string,
    sessionId: string,
    visionCaptureRequestId: string,
    headers: Record<string, string>,
): Promise<void> {
    try {
        await fetch(
            `${baseUrl}/api/vision/requests/${visionCaptureRequestId}?sessionId=${sessionId}`,
            { method: 'DELETE', headers },
        );
        console.log('[Vision] Canceled vision request');
    } catch (err) {
        console.error('[Vision] Failed to cancel vision request:', err);
    }
}
