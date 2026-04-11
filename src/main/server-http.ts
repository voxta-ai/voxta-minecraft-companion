import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs/promises';
import type { SetupProgress } from '../shared/ipc-types';

const USER_AGENT = 'voxta-minecraft-companion';

/**
 * Fetch JSON from a URL with redirect handling.
 */
export function fetchJson(url: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client
            .get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
                // Handle redirects
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    fetchJson(res.headers.location).then(resolve, reject);
                    return;
                }

                let data = '';
                res.on('data', (chunk: Buffer) => {
                    data += chunk.toString();
                });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data) as Record<string, unknown>);
                    } catch {
                        reject(new Error(`Failed to parse JSON from ${url}`));
                    }
                });
            })
            .on('error', reject);
    });
}

/**
 * Download a file from a URL with redirect handling and optional progress reporting.
 */
export function downloadFile(
    url: string,
    dest: string,
    onProgress?: (progress: SetupProgress) => void,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client
            .get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
                // Handle redirects (GitHub releases use 302)
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
                    return;
                }

                if (res.statusCode && res.statusCode !== 200) {
                    reject(new Error(`Download failed with status ${res.statusCode}`));
                    return;
                }

                const totalBytes = parseInt(res.headers['content-length'] ?? '0', 10);
                let downloadedBytes = 0;

                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => {
                    chunks.push(chunk);
                    downloadedBytes += chunk.length;
                    if (totalBytes > 0 && onProgress) {
                        onProgress({
                            step: 0,
                            totalSteps: 0,
                            label: `Downloading... ${Math.round((downloadedBytes / totalBytes) * 100)}%`,
                            bytesDownloaded: downloadedBytes,
                            bytesTotal: totalBytes,
                        });
                    }
                });
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    fs.writeFile(dest, buffer).then(resolve, reject);
                });
            })
            .on('error', reject);
    });
}
