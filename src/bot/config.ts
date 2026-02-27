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
