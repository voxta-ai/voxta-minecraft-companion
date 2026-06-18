import { exec } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { downloadFile } from './server-http';
import type { SetupProgress } from '../shared/ipc-types';

// Paper 1.20.5+ / 1.21 require Java 21. We download a managed Temurin JRE 21
// when the user has no suitable Java on PATH so the server runs out of the box.
const JAVA_FEATURE_VERSION = 21;

// Adoptium redirects this to the actual GitHub asset (a .zip on Windows).
// downloadFile follows the 302, so we can use the stable "latest" endpoint.
const ADOPTIUM_JRE_URL =
    `https://api.adoptium.net/v3/binary/latest/${JAVA_FEATURE_VERSION}/ga/windows/x64/jre/hotspot/normal/eclipse`;

const MANUAL_DOWNLOAD_URL = 'https://adoptium.net/temurin/releases/?version=' + JAVA_FEATURE_VERSION;

type ConsoleEmit = (text: string, level: 'info' | 'warn' | 'error') => void;
type ProgressEmit = (progress: SetupProgress) => void;

/**
 * Resolves a usable Java runtime for the Paper server. Prefers a managed JRE
 * we previously downloaded, then a recent-enough system Java on PATH, and
 * finally auto-downloads a Temurin JRE. Throws a user-friendly error (with a
 * manual download link) only when every option fails.
 */
export class JavaManager {
    private readonly javaDir: string;

    constructor() {
        this.javaDir = path.join(app.getPath('userData'), 'java');
    }

    /** Returns an absolute path to java.exe (or bare 'java' when using a suitable system install). */
    async resolveJavaPath(onConsole: ConsoleEmit, onProgress: ProgressEmit): Promise<string> {
        // 1. Managed JRE we downloaded on a previous run.
        const managed = await this.findManagedJavaPath();
        if (managed && (await this.probeJavaMajor(managed)) !== null) {
            return managed;
        }

        // 2. A recent-enough Java already on the system PATH.
        const systemMajor = await this.probeJavaMajor('java');
        if (systemMajor !== null && systemMajor >= JAVA_FEATURE_VERSION) {
            return 'java';
        }
        if (systemMajor !== null) {
            onConsole(
                `Found Java ${systemMajor} on PATH, but Paper needs Java ${JAVA_FEATURE_VERSION}+. Downloading a compatible runtime...`,
                'warn',
            );
        } else {
            onConsole('No Java runtime found on this system. Downloading one automatically (one-time setup)...', 'info');
        }

        // 3. Download and extract a managed JRE.
        try {
            return await this.downloadAndExtractJre(onConsole, onProgress);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Could not set up a Java runtime automatically (${msg}). ` +
                    `Please install Java ${JAVA_FEATURE_VERSION} from ${MANUAL_DOWNLOAD_URL} and try again.`,
                { cause: err },
            );
        }
    }

    private async downloadAndExtractJre(onConsole: ConsoleEmit, onProgress: ProgressEmit): Promise<string> {
        await fs.mkdir(this.javaDir, { recursive: true });
        const zipPath = path.join(this.javaDir, 'jre.zip');

        onConsole(`Downloading Java ${JAVA_FEATURE_VERSION} runtime...`, 'info');
        await downloadFile(ADOPTIUM_JRE_URL, zipPath, onProgress);

        onConsole('Extracting Java runtime...', 'info');
        await this.extractZip(zipPath, this.javaDir);
        await fs.unlink(zipPath).catch(() => {
            /* best effort */
        });

        const javaPath = await this.findManagedJavaPath();
        if (!javaPath) {
            throw new Error('java.exe could not be located after extraction');
        }
        onConsole('Java runtime installed.', 'info');
        return javaPath;
    }

    /** Locate bin/java.exe inside any extracted JRE folder (e.g. jdk-21.0.x+y-jre/). */
    private async findManagedJavaPath(): Promise<string | null> {
        try {
            const entries = await fs.readdir(this.javaDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const candidate = path.join(this.javaDir, entry.name, 'bin', 'java.exe');
                try {
                    await fs.access(candidate);
                    return candidate;
                } catch {
                    // Keep looking
                }
            }
        } catch {
            // java dir doesn't exist yet
        }
        return null;
    }

    /** Run `<java> -version` and return the major version, or null if it can't be run. */
    private probeJavaMajor(javaCmd: string): Promise<number | null> {
        return new Promise((resolve) => {
            const quoted = javaCmd === 'java' ? 'java' : `"${javaCmd}"`;
            exec(`${quoted} -version`, (err, stdout, stderr) => {
                if (err) {
                    resolve(null);
                    return;
                }
                // `java -version` prints to stderr, e.g. openjdk version "21.0.1"
                const text = stderr || stdout || '';
                const match = text.match(/version "(\d+)(?:\.(\d+))?/);
                if (!match) {
                    resolve(null);
                    return;
                }
                const first = parseInt(match[1], 10);
                // Legacy scheme: 1.8 means major 8
                const major = first === 1 && match[2] ? parseInt(match[2], 10) : first;
                resolve(Number.isNaN(major) ? null : major);
            });
        });
    }

    private extractZip(zipPath: string, destDir: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force"`;
            exec(cmd, (err) => {
                if (err) {
                    reject(new Error(`extraction failed: ${err.message}`));
                    return;
                }
                resolve();
            });
        });
    }
}
