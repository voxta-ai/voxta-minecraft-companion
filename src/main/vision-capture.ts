import { desktopCapturer } from 'electron';

/**
 * Handles Voxta vision capture requests by screenshotting the Minecraft window
 * and POSTing the image back to Voxta's vision API.
 */

interface VisionCaptureRequest {
    sessionId: string;
    visionCaptureRequestId: string;
    source: string;
}

/**
 * Find the Minecraft window and capture a screenshot.
 * Returns a JPEG Buffer or null if not found.
 */
async function captureMinecraftWindow(): Promise<Buffer | null> {
    const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1024, height: 768 },
    });

    // Find the actual Minecraft game window (not dev tools like "voxta-minecraft-companion")
    const mcSource = sources.find((s) => {
        const name = s.name.toLowerCase();
        return name.startsWith('minecraft') && !name.includes('companion') && !name.includes('voxta');
    });

    if (!mcSource) {
        console.log('[Vision] Minecraft window not found among:', sources.map((s) => s.name).join(', '));
        return null;
    }

    console.log(`[Vision] Captured Minecraft window: "${mcSource.name}"`);
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
): Promise<void> {
    const { sessionId, visionCaptureRequestId, source } = request;

    const headers: Record<string, string> = {};
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
        const imageBuffer = await captureMinecraftWindow();

        if (!imageBuffer) {
            console.warn('[Vision] No Minecraft window found — canceling vision request');
            await cancelVisionRequest(baseUrl, sessionId, visionCaptureRequestId, headers);
            return;
        }

        // POST the image as multipart/form-data
        const blob = new Blob([new Uint8Array(imageBuffer)], { type: 'image/jpeg' });
        const formData = new FormData();
        formData.append('file', blob, 'minecraft.jpg');

        const url = `${baseUrl}/api/vision/requests/${visionCaptureRequestId}/send?sessionId=${sessionId}&source=${source}&label=minecraft`;

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: formData,
        });

        if (response.ok) {
            console.log('[Vision] Screenshot sent to Voxta');
        } else {
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
