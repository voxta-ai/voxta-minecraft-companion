/**
 * Console line tokenizer with VS Code-style coloring.
 * Adapted from Voxta Talk's ConsoleFormatting.ts — simplified for the
 * Minecraft companion (no pip/tqdm progress parsing).
 */

export interface ConsoleToken {
    text: string;
    color?: string;
    isUrl?: boolean;
}

export const ConsoleColors = {
    Time: '#6A9955',
    Context: '#569CD6',
    Guid: '#CE9178',
    Url: '#569CD6',

    Path: '#9CDCFE',
    Number: '#B5CEA8',
    String: '#CE9178',

    StackAt: '#569CD6',
    StackMethod: '#DCDCAA',
    StackArgs: '#808080',
    StackPath: '#4EC9B0',

    LevelDbg: '#808080',
    LevelInf: '#DCDCDC',
    LevelWrn: '#DCDCAA',
    LevelErr: '#F44747',
    Success: '#6A9955',
    Action: '#C586C0',

    Default: '#D4D4D4',
};

// --- Regex Patterns ---

// Standard app logs: [12:00:00 Context INF]
const LogHeaderRegex = /^\[(\d{2}:\d{2}:\d{2})\s+([^\]]+?)\s+(INF|DBG|WRN|ERR|VRB|FTL)](.*)/;

// Stack traces
const StackTraceRegex = /^\s*(at)\s+([^ (]+)(\(.*)/;
const StackTraceLocationRegex = /(.*)(\\s+in\\s+)(.+:line\\s+\\d+.*)/;

// Exception headers
const ExceptionLineRegex = /^(\s*---\>|\s*Unhandled exception|\s*--- End of|[\w.]*Exception:)/;

// URLs
const UrlRegex = /(https?:\/\/\S+)/gi;

// Paths (Windows + Unix)
const PathRegex =
    /([a-zA-Z]:\\[\w\-.\\\+]+|\(Voxta\)\\[\w\-.\\\+]+|\.{0,2}\/[\w\-.\\\/]+\/[\w\-.\\\/]+)/gi;

// GUIDs
const GuidRegex = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;

// Versions
const VersionRegex = /((?:==|@\s?|v)\d+(?:\.\d+)+)/gi;

// Keywords
const KeywordsAction =
    /\b(Downloading|Installing|Collecting|Running|Using cached|Upgrading|Building|Starting|Connect)\b/gi;
const KeywordsSuccess = /\b(Successfully|satisfied|completed|Done|Installation complete)\b/gi;
const KeywordsWarning = /\b(skipping|already exists|conflict)\b/gi;
const KeywordsError = /\b(Failed|Error|Exception|Could not find)\b/gi;

// Minecraft-specific patterns
const McBracketTag = /\[(\w[\w\s]*?)\]/g;

export const parseConsoleLine = (text: string): ConsoleToken[] => {
    if (!text) return [];

    // 1. Standard log header
    const headerMatch = LogHeaderRegex.exec(text);
    if (headerMatch) {
        const tokens: ConsoleToken[] = [];
        tokens.push({ text: '[', color: ConsoleColors.Default });
        tokens.push({ text: headerMatch[1], color: ConsoleColors.Time });
        tokens.push({ text: ' ', color: ConsoleColors.Default });
        tokens.push({ text: headerMatch[2], color: ConsoleColors.Context });

        const level = headerMatch[3];
        tokens.push({ text: ' ' + level, color: getLevelColor(level) });
        tokens.push({ text: ']', color: ConsoleColors.Default });
        tokens.push(...parseMessageBody(headerMatch[4]));
        return tokens;
    }

    // 2. Stack trace
    const stackMatch = StackTraceRegex.exec(text);
    if (stackMatch) {
        const tokens: ConsoleToken[] = [];
        const prefix = text.substring(0, text.indexOf(stackMatch[1]));
        if (prefix) tokens.push({ text: prefix, color: ConsoleColors.Default });

        tokens.push({ text: stackMatch[1], color: ConsoleColors.StackAt });
        tokens.push({ text: ' ' });
        tokens.push({ text: stackMatch[2], color: ConsoleColors.StackMethod });

        const argsAndPath = stackMatch[3];
        const locMatch = StackTraceLocationRegex.exec(argsAndPath);

        if (locMatch) {
            tokens.push({ text: locMatch[1], color: ConsoleColors.StackArgs });
            tokens.push({ text: locMatch[2], color: ConsoleColors.StackArgs });
            tokens.push({ text: locMatch[3], color: ConsoleColors.StackPath });
        } else {
            tokens.push({ text: argsAndPath, color: ConsoleColors.StackArgs });
        }
        return tokens;
    }

    // 3. Exception lines
    if (ExceptionLineRegex.test(text)) {
        return parseMessageBody(text, ConsoleColors.LevelErr);
    }

    // 4. Default body parsing
    return parseMessageBody(text);
};

const parseMessageBody = (text: string, overrideColor?: string): ConsoleToken[] => {
    if (!text) return [];

    const matchers = [
        { regex: UrlRegex, color: ConsoleColors.Url, isUrl: true },
        { regex: PathRegex, color: ConsoleColors.Path, isUrl: false },
        { regex: GuidRegex, color: ConsoleColors.Guid, isUrl: false },
        { regex: VersionRegex, color: ConsoleColors.Number, isUrl: false },
        { regex: McBracketTag, color: ConsoleColors.Context, isUrl: false },
        { regex: KeywordsAction, color: ConsoleColors.Action, isUrl: false },
        { regex: KeywordsSuccess, color: ConsoleColors.Success, isUrl: false },
        { regex: KeywordsWarning, color: ConsoleColors.LevelWrn, isUrl: false },
        { regex: KeywordsError, color: ConsoleColors.LevelErr, isUrl: false },
    ];

    const allMatches: { index: number; length: number; color: string; isUrl: boolean }[] = [];

    for (const matcher of matchers) {
        matcher.regex.lastIndex = 0;
        const matches = Array.from(text.matchAll(matcher.regex));
        for (const m of matches) {
            if (m.index !== undefined) {
                allMatches.push({
                    index: m.index,
                    length: m[0].length,
                    color: matcher.color,
                    isUrl: matcher.isUrl || false,
                });
            }
        }
    }

    allMatches.sort((a, b) => a.index - b.index);

    const tokens: ConsoleToken[] = [];
    let currentIndex = 0;

    for (const match of allMatches) {
        if (match.index < currentIndex) continue;

        if (match.index > currentIndex) {
            tokens.push({
                text: text.substring(currentIndex, match.index),
                color: overrideColor || ConsoleColors.Default,
            });
        }

        tokens.push({
            text: text.substring(match.index, match.index + match.length),
            color: match.color,
            isUrl: match.isUrl,
        });

        currentIndex = match.index + match.length;
    }

    if (currentIndex < text.length) {
        tokens.push({
            text: text.substring(currentIndex),
            color: overrideColor || ConsoleColors.Default,
        });
    }

    return tokens;
};

const getLevelColor = (level: string): string => {
    switch (level) {
        case 'INF':
            return ConsoleColors.LevelInf;
        case 'DBG':
            return ConsoleColors.LevelDbg;
        case 'WRN':
            return ConsoleColors.LevelWrn;
        case 'ERR':
        case 'FTL':
            return ConsoleColors.LevelErr;
        default:
            return ConsoleColors.LevelInf;
    }
};
