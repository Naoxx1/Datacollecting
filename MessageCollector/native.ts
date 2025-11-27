import { IpcMainInvokeEvent } from "electron";

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const { exec } = require("child_process") as typeof import("child_process");

const BASE_PATH = "C:\\DiscordMessages";

function sanitize(name: string): string {
    return name
        .replace(/[<>:"/\\|?*]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_{2,}/g, "_")
        .substring(0, 80);
}

function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function getTimestamp(): string {
    return new Date().toISOString()
        .replace(/T/, "_")
        .replace(/:/g, "-")
        .replace(/\..+/, "");
}

export function saveMessage(
    _: IpcMainInvokeEvent,
    accountName: string,
    serverName: string,
    authorName: string,
    timestamp: string,
    content: string,
    attachments: string[],
    messageId: string,
    channelName: string
): { success: boolean; path?: string; error?: string } {
    try {
        const accountPath = path.join(BASE_PATH, sanitize(accountName));
        const serverPath = path.join(accountPath, sanitize(serverName));
        const authorPath = path.join(serverPath, sanitize(authorName));
        
        ensureDir(authorPath);
        
        const preview = sanitize((content || "no_text").substring(0, 40));
        const fileName = getTimestamp() + "_" + preview + ".txt";
        const filePath = path.join(authorPath, fileName);
        
        let fileContent = "Date: " + timestamp + "\n";
        fileContent += "Channel: " + channelName + "\n";
        fileContent += "Message ID: " + messageId + "\n";
        fileContent += "---\n\n";
        fileContent += content || "[empty]";
        
        if (attachments.length > 0) {
            fileContent += "\n\nAttachments:\n";
            attachments.forEach((url, i) => {
                fileContent += (i + 1) + ". " + url + "\n";
            });
        }
        
        fs.writeFileSync(filePath, fileContent, "utf8");
        
        const logPath = path.join(authorPath, "_all_messages.txt");
        let logEntry = "[" + timestamp + "] [#" + channelName + "]\n" + content + "\n";
        if (attachments.length > 0) {
            logEntry += "Attachments: " + attachments.join(", ") + "\n";
        }
        logEntry += "-".repeat(50) + "\n";
        
        fs.appendFileSync(logPath, logEntry, "utf8");
        
        return { success: true, path: filePath };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}

export function getStats(_: IpcMainInvokeEvent): { 
    totalFiles: number; 
    basePath: string;
    exists: boolean;
} {
    try {
        ensureDir(BASE_PATH);
        
        const countFiles = (dir: string): number => {
            let count = 0;
            if (!fs.existsSync(dir)) return 0;
            
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const itemPath = path.join(dir, item);
                const stat = fs.statSync(itemPath);
                if (stat.isDirectory()) {
                    count += countFiles(itemPath);
                } else if (item.endsWith(".txt") && !item.startsWith("_")) {
                    count++;
                }
            }
            return count;
        };
        
        return {
            totalFiles: countFiles(BASE_PATH),
            basePath: BASE_PATH,
            exists: fs.existsSync(BASE_PATH)
        };
    } catch (error) {
        return { totalFiles: 0, basePath: BASE_PATH, exists: false };
    }
}

export function openFolder(_: IpcMainInvokeEvent): { success: boolean } {
    try {
        ensureDir(BASE_PATH);
        exec("explorer \"" + BASE_PATH + "\"");
        return { success: true };
    } catch (error) {
        return { success: false };
    }
}

export function initFolder(_: IpcMainInvokeEvent): { success: boolean; path: string } {
    try {
        ensureDir(BASE_PATH);
        return { success: true, path: BASE_PATH };
    } catch (error) {
        return { success: false, path: BASE_PATH };
    }
}
