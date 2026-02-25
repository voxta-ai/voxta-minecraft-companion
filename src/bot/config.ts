export interface CompanionConfig {
    mc: {
        host: string;
        port: number;
        username: string;
        version: string;
    };
    voxta: {
        url: string;
        apiKey: string;
        clientName: string;
        clientVersion: string;
    };
    perception: {
        intervalMs: number;
        entityRange: number;
    };
}

export function loadConfig(): CompanionConfig {
    const args = process.argv.slice(2);

    function getArg(name: string, fallback: string): string {
        const index = args.indexOf(`--${name}`);
        if (index !== -1 && args[index + 1]) {
            return args[index + 1];
        }
        return process.env[name.toUpperCase().replace(/-/g, '_')] ?? fallback;
    }

    return {
        mc: {
            host: getArg('mc-host', 'localhost'),
            port: parseInt(getArg('mc-port', '25565'), 10),
            username: getArg('mc-username', 'VoxtaBot'),
            version: getArg('mc-version', '1.21.11'),
        },
        voxta: {
            url: getArg('voxta-url', 'http://localhost:5384/hub'),
            apiKey: getArg('voxta-api-key', ''),
            clientName: 'Voxta.Minecraft',
            clientVersion: '0.1.0',
        },
        perception: {
            intervalMs: parseInt(getArg('perception-interval', '3000'), 10),
            entityRange: parseInt(getArg('entity-range', '32'), 10),
        },
    };
}
