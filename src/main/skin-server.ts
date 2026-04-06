import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

/**
 * Uploads a skin PNG to a free anonymous file host and returns a public URL
 * that MineSkin (used by SkinsRestorer) can download.
 *
 * Results are cached by file hash so each unique skin is only uploaded once.
 * Cache is stored in the app's userData directory.
 */

const CACHE_FILE = path.join(app.getPath('userData'), 'skin-url-cache.json');

interface SkinCacheEntry {
    hash: string;
    publicUrl: string;
    timestamp: number;
}

type SkinCache = Record<string, SkinCacheEntry>;

function loadCache(): SkinCache {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as SkinCache;
        }
    } catch {
        // Corrupted cache — start fresh
    }
    return {};
}

function saveCache(cache: SkinCache): void {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (err) {
        console.error('[Skin Upload] Failed to save cache:', err);
    }
}

function hashBuffer(buf: Buffer): string {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Upload skin PNG bytes to a public file host and return the public URL.
 * Uses cache to avoid re-uploading the same skin.
 *
 * Cache expires after 24 hours (temp hosts retain files for at least 24-72h).
 */
export async function getPublicSkinUrl(pngBytes: Buffer): Promise<string | null> {
    const hash = hashBuffer(pngBytes);
    const cache = loadCache();
    const cached = cache[hash];

    const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

    if (cached && Date.now() - cached.timestamp < CACHE_MAX_AGE_MS) {
        console.log(`[Skin Upload] Cache hit for hash ${hash.substring(0, 12)}... → ${cached.publicUrl}`);
        return cached.publicUrl;
    }

    // Try multiple hosts with fallback
    const uploaders: Array<{ name: string; fn: (buf: Buffer) => Promise<string | null> }> = [
        { name: 'litterbox.catbox.moe', fn: uploadToLitterbox },
        { name: 'tmpfiles.org', fn: uploadToTmpfiles },
    ];

    for (const uploader of uploaders) {
        console.log(`[Skin Upload] Trying ${uploader.name}...`);
        const url = await uploader.fn(pngBytes);
        if (url) {
            cache[hash] = { hash, publicUrl: url, timestamp: Date.now() };
            saveCache(cache);
            console.log(`[Skin Upload] Success via ${uploader.name}: ${url}`);
            return url;
        }
    }

    console.error('[Skin Upload] All upload attempts failed');
    return null;
}

/** Upload to litterbox.catbox.moe — temporary file host (up to 72h, no API key) */
async function uploadToLitterbox(pngBytes: Buffer): Promise<string | null> {
    try {
        const blob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' });
        const formData = new FormData();
        formData.append('reqtype', 'fileupload');
        formData.append('time', '72h');
        formData.append('fileToUpload', blob, 'skin.png');

        const response = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const text = await response.text();
            console.error(`[Skin Upload] litterbox returned ${response.status}: ${text.substring(0, 100)}`);
            return null;
        }

        const url = (await response.text()).trim();
        if (url.startsWith('http')) {
            return url;
        }

        console.error(`[Skin Upload] litterbox unexpected response: ${url.substring(0, 100)}`);
        return null;
    } catch (err) {
        console.error('[Skin Upload] litterbox failed:', err);
        return null;
    }
}

/** Upload to tmpfiles.org — temporary file host (1 hour retention, no API key) */
async function uploadToTmpfiles(pngBytes: Buffer): Promise<string | null> {
    try {
        const blob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' });
        const formData = new FormData();
        formData.append('file', blob, 'skin.png');

        const response = await fetch('https://tmpfiles.org/api/v1/upload', {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const text = await response.text();
            console.error(`[Skin Upload] tmpfiles returned ${response.status}: ${text.substring(0, 100)}`);
            return null;
        }

        const json = await response.json() as { status: string; data?: { url?: string } };
        // tmpfiles.org returns a page URL like https://tmpfiles.org/12345/skin.png
        // Convert to direct download: https://tmpfiles.org/dl/12345/skin.png
        const pageUrl = json.data?.url;
        if (pageUrl && pageUrl.startsWith('https://tmpfiles.org/')) {
            const directUrl = pageUrl.replace('https://tmpfiles.org/', 'https://tmpfiles.org/dl/');
            return directUrl;
        }

        console.error(`[Skin Upload] tmpfiles unexpected response: ${JSON.stringify(json).substring(0, 100)}`);
        return null;
    } catch (err) {
        console.error('[Skin Upload] tmpfiles failed:', err);
        return null;
    }
}
