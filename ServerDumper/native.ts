import { IpcMainInvokeEvent } from "electron";

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const { exec } = require("child_process") as typeof import("child_process");
const https = require("https") as typeof import("https");

const BASE_PATH = "C:\\DiscordServerDumps";

// Catégories disponibles
const CATEGORIES = {
    IMAGES: "Images",
    VIDEOS: "Videos",
    COMMANDES: "Commandes",
    INFOS_PERSONNELLES: "Infos_Personnelles",
    INAPPROPRIE: "Inapproprie",
    LIENS: "Liens",
    FICHIERS: "Fichiers",
    CONVERSATIONS: "Conversations"
};

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

function getDateFolder(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Détection locale des catégories (pour les cas évidents)
function detectCategoryLocal(content: string, attachments: string[]): string | null {
    // Vérifier les attachements d'abord
    const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];
    const videoExtensions = [".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv"];
    const fileExtensions = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".zip", ".rar", ".txt", ".json"];

    for (const url of attachments) {
        const lowerUrl = url.toLowerCase();
        if (imageExtensions.some(ext => lowerUrl.includes(ext))) {
            return CATEGORIES.IMAGES;
        }
        if (videoExtensions.some(ext => lowerUrl.includes(ext))) {
            return CATEGORIES.VIDEOS;
        }
        if (fileExtensions.some(ext => lowerUrl.includes(ext))) {
            return CATEGORIES.FICHIERS;
        }
    }

    // Vérifier si c'est une commande
    const commandPrefixes = ["/", "!", "?", ".", "-", "$", "%", "&", ">", "<"];
    if (content && commandPrefixes.some(prefix => content.trim().startsWith(prefix))) {
        return CATEGORIES.COMMANDES;
    }

    // Vérifier si contient des liens
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    if (content && urlRegex.test(content)) {
        const urls = content.match(urlRegex) || [];
        for (const url of urls) {
            const lowerUrl = url.toLowerCase();
            if (imageExtensions.some(ext => lowerUrl.includes(ext))) {
                return CATEGORIES.IMAGES;
            }
            if (videoExtensions.some(ext => lowerUrl.includes(ext))) {
                return CATEGORIES.VIDEOS;
            }
        }
        return CATEGORIES.LIENS;
    }

    // Détection d'infos personnelles
    const personalInfoPatterns = [
        /\b(mon|my|email|mail|contact|adresse)\s*:?\s*[\w.-]+@[\w.-]+\.\w+\b/i,
        /\b(tel|phone|telephone|numero|number|appel|call|contact)\s*:?\s*[\d\s.+-]{10,}/i,
        /\b(habite|j'habite|live at|address|adresse|rue|street|avenue|boulevard)\s*:?\s*.{10,}/i,
        /\b(né le|born|anniversaire|birthday|naissance|dob|date of birth)\s*:?\s*\d{1,2}[-/.\s]\d{1,2}[-/.\s]\d{2,4}/i,
        /\b(password|mdp|mot de passe|pwd|login|identifiant)\s*:?\s*\S+/i,
        /\b(j'ai|i am|i'm|age)\s*:?\s*\d{1,2}\s*(ans|years?\s*old)/i,
        /\b(je m'appelle|my name is|i'm called|nom complet|full name)\s*:?\s*[A-Z][a-z]+\s+[A-Z][a-z]+/i,
    ];

    if (content) {
        for (const pattern of personalInfoPatterns) {
            if (pattern.test(content)) {
                return CATEGORIES.INFOS_PERSONNELLES;
            }
        }
    }

    // Détection de contenu inapproprié
    const inappropriatePatterns = [
        /\b(tu es?|you'?re|t'es|toi|you)\s+(un\s+)?(connard|connasse|salope|pute|pd|pédé|gogol|débile|crétin|abruti|bitch|asshole|retard|faggot|cunt|whore|slut)\b/i,
        /\b(nique\s+(ta|sa|leur)|ntm|fdp|fils de pute|ta gueule|ferme ta gueule|va te faire|casse toi)\b/i,
        /\b(fuck you|fuck off|stfu|gtfo|kys|kill yourself)\b/i,
        /\b(nigga|nigger)\b/i,
        /\b(porn|hentai|nsfw|xxx|dick pic|nudes)\b/i,
        /\b(je vais te|i('ll| will)\s+(kill|murder|rape))\b/i,
    ];

    if (content) {
        const lowerContent = content.toLowerCase();
        for (const pattern of inappropriatePatterns) {
            if (pattern.test(lowerContent)) {
                return CATEGORIES.INAPPROPRIE;
            }
        }
    }

    return null;
}

// Classification par IA via Pollinations
function classifyWithAI(content: string): Promise<string> {
    return new Promise((resolve) => {
        if (!content || content.trim().length < 3) {
            resolve(CATEGORIES.CONVERSATIONS);
            return;
        }

        const prompt = `Tu es un classificateur de messages Discord. Analyse le CONTEXTE et l'INTENTION.

RÈGLES IMPORTANTES:
- Les expressions familières (holy shit, damn, wtf) = CONVERSATIONS, pas inapproprié
- Les prix de jeux vidéo, stocks de shop, messages de bots (Mudae, etc.) = COMMANDES, PAS infos personnelles
- Les pseudos Discord, noms de personnages de jeux = PAS des infos personnelles
- INFOS_PERSONNELLES = UNIQUEMENT si quelqu'un partage SES VRAIES infos: son email perso, son vrai numéro, son adresse, sa date de naissance, son mot de passe

Catégories:
- IMAGES: parle d'images, photos, screenshots
- VIDEOS: parle de vidéos, clips, streams  
- COMMANDES: messages de bots, commandes, réponses de bots, stock de shop de jeux, résultats de rolls
- INFOS_PERSONNELLES: UNIQUEMENT vraies infos personnelles partagées volontairement (email, téléphone, adresse, mdp)
- INAPPROPRIE: insulte DIRECTE, harcèlement, menaces, contenu sexuel explicite, propos racistes
- LIENS: contient ou parle de liens/URLs
- FICHIERS: parle de fichiers, documents
- CONVERSATIONS: discussions normales, tout le reste

Message: "${content.substring(0, 500)}"

UN SEUL MOT: IMAGES, VIDEOS, COMMANDES, INFOS_PERSONNELLES, INAPPROPRIE, LIENS, FICHIERS ou CONVERSATIONS`;

        const postData = JSON.stringify({
            model: "openai",
            messages: [
                { role: "user", content: prompt }
            ],
            temperature: 0.1
        });

        const options = {
            hostname: "text.pollinations.ai",
            port: 443,
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            },
            timeout: 5000
        };

        const req = https.request(options, (res: any) => {
            let data = "";
            res.on("data", (chunk: any) => { data += chunk; });
            res.on("end", () => {
                try {
                    const json = JSON.parse(data);
                    const response = json.choices?.[0]?.message?.content?.trim().toUpperCase() || "";
                    
                    if (response.includes("IMAGES")) resolve(CATEGORIES.IMAGES);
                    else if (response.includes("VIDEOS")) resolve(CATEGORIES.VIDEOS);
                    else if (response.includes("COMMANDES")) resolve(CATEGORIES.COMMANDES);
                    else if (response.includes("INFOS_PERSONNELLES") || response.includes("INFOS") || response.includes("PERSONNEL")) resolve(CATEGORIES.INFOS_PERSONNELLES);
                    else if (response.includes("INAPPROPRIE") || response.includes("NSFW") || response.includes("INSULTE")) resolve(CATEGORIES.INAPPROPRIE);
                    else if (response.includes("LIENS")) resolve(CATEGORIES.LIENS);
                    else if (response.includes("FICHIERS")) resolve(CATEGORIES.FICHIERS);
                    else resolve(CATEGORIES.CONVERSATIONS);
                } catch {
                    resolve(CATEGORIES.CONVERSATIONS);
                }
            });
        });

        req.on("error", () => resolve(CATEGORIES.CONVERSATIONS));
        req.on("timeout", () => {
            req.destroy();
            resolve(CATEGORIES.CONVERSATIONS);
        });

        req.write(postData);
        req.end();
    });
}

// Catégoriser un message avec IA (async) - même logique que MessageCollector
async function categorizeMessageAsync(content: string, attachments: string[], useAI: boolean): Promise<string> {
    // Déterminer la catégorie
    let category = detectCategoryLocal(content, attachments);
    
    // Si pas de catégorie évidente et IA activée, utiliser l'IA
    if (!category && useAI && content && content.trim().length > 0) {
        category = await classifyWithAI(content);
    }
    
    // Catégorie par défaut
    if (!category) {
        category = CATEGORIES.CONVERSATIONS;
    }
    
    return category;
}

// Fonction pour sauvegarder un message individuel (même structure que MessageCollector)
async function saveMessageIndividual(
    accountName: string,
    serverName: string,
    authorName: string,
    timestamp: string,
    content: string,
    attachments: string[],
    messageId: string,
    channelName: string,
    useAI: boolean
): Promise<{ success: boolean; category?: string; error?: string }> {
    try {
        // Déterminer la catégorie
        let category = detectCategoryLocal(content, attachments);
        
        // Si pas de catégorie évidente et IA activée, utiliser l'IA
        if (!category && useAI && content && content.trim().length > 0) {
            category = await categorizeMessageAsync(content, attachments, useAI);
        }
        
        // Catégorie par défaut
        if (!category) {
            category = CATEGORIES.CONVERSATIONS;
        }

        // Structure: Compte > Auteur > Serveur > Catégorie (comme MessageCollector)
        const accountPath = path.join(BASE_PATH, sanitize(accountName));
        const authorPath = path.join(accountPath, sanitize(authorName));
        const serverPath = path.join(authorPath, sanitize(serverName));
        const categoryPath = path.join(serverPath, sanitize(category));
        
        ensureDir(categoryPath);
        
        const preview = sanitize((content || "no_text").substring(0, 40));
        const fileName = getTimestamp() + "_" + preview + ".txt";
        const filePath = path.join(categoryPath, fileName);
        
        let fileContent = "Date: " + timestamp + "\n";
        fileContent += "Channel: " + channelName + "\n";
        fileContent += "Message ID: " + messageId + "\n";
        fileContent += "Catégorie: " + category + "\n";
        fileContent += "---\n\n";
        fileContent += content || "[empty]";
        
        if (attachments.length > 0) {
            fileContent += "\n\nAttachments:\n";
            attachments.forEach((url, i) => {
                fileContent += (i + 1) + ". " + url + "\n";
            });
        }
        
        fs.writeFileSync(filePath, fileContent, "utf8");
        
        // === DOSSIER PAR CATÉGORIE UNIQUEMENT ===
        const globalCategoryPath = path.join(accountPath, "_Par_Categorie", sanitize(category));
        ensureDir(globalCategoryPath);
        
        // Fichier individuel dans le dossier catégorie globale
        const globalCategoryFileName = getTimestamp() + "_" + sanitize(authorName) + "_" + sanitize(serverName) + "_" + preview + ".txt";
        const globalCategoryFilePath = path.join(globalCategoryPath, globalCategoryFileName);
        
        let globalFileContent = "Date: " + timestamp + "\n";
        globalFileContent += "Auteur: " + authorName + "\n";
        globalFileContent += "Serveur: " + serverName + "\n";
        globalFileContent += "Channel: " + channelName + "\n";
        globalFileContent += "Message ID: " + messageId + "\n";
        globalFileContent += "Catégorie: " + category + "\n";
        globalFileContent += "---\n\n";
        globalFileContent += content || "[empty]";
        
        if (attachments.length > 0) {
            globalFileContent += "\n\nAttachments:\n";
            attachments.forEach((url, i) => {
                globalFileContent += (i + 1) + ". " + url + "\n";
            });
        }
        
        fs.writeFileSync(globalCategoryFilePath, globalFileContent, "utf8");
        
        return { success: true, category: category };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}

// Fonction pour sauvegarder un channel individuel de manière incrémentale
export async function saveChannelToGuildDump(
    _: IpcMainInvokeEvent,
    accountName: string,
    guildName: string,
    guildId: string,
    channelName: string,
    channelId: string,
    messages: Array<{
        author: string;
        authorId: string;
        content: string;
        timestamp: string;
        attachments: string[];
        id: string;
    }>,
    useAI: boolean = false
): Promise<{ success: boolean; path?: string; error?: string; categoryStats?: { [key: string]: number } }> {
    try {
        ensureDir(BASE_PATH);
        
        // Stats par catégorie pour ce channel
        const categoryStats: { [key: string]: number } = {};
        Object.values(CATEGORIES).forEach(cat => { categoryStats[cat] = 0; });
        
        // Sauvegarder chaque message individuellement
        for (const msg of messages) {
            const result = await saveMessageIndividual(
                accountName,
                guildName,
                msg.author,
                msg.timestamp,
                msg.content,
                msg.attachments,
                msg.id,
                channelName,
                useAI
            );
            
            if (result.success && result.category) {
                categoryStats[result.category] = (categoryStats[result.category] || 0) + 1;
            }
        }
        
        return { success: true, categoryStats };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}

// Fonction pour finaliser le résumé du serveur après tous les channels (optionnel, car structure différente maintenant)
export function finalizeGuildDumpSummary(
    _: IpcMainInvokeEvent,
    guildName: string,
    guildId: string,
    channelsData: Array<{
        channelName: string;
        messageCount: number;
    }>,
    totalMessages: number,
    categoryStats: { [key: string]: number }
): { success: boolean; error?: string } {
    // Plus besoin de résumé car la structure est maintenant comme MessageCollector
    // Les messages sont déjà sauvegardés individuellement
    return { success: true };
}

export async function saveGuildDump(
    _: IpcMainInvokeEvent,
    guildName: string,
    guildId: string,
    channelsData: Array<{
        channelName: string;
        channelId: string;
        messages: Array<{
            author: string;
            authorId: string;
            content: string;
            timestamp: string;
            attachments: string[];
            id: string;
        }>;
    }>,
    totalMessages: number,
    useAI: boolean = false
): Promise<{ success: boolean; path?: string; error?: string; categoryStats?: { [key: string]: number } }> {
    try {
        ensureDir(BASE_PATH);
        
        const dateFolder = getDateFolder();
        const datePath = path.join(BASE_PATH, dateFolder);
        ensureDir(datePath);
        
        const serverPath = path.join(datePath, sanitize(guildName) + "_" + guildId);
        ensureDir(serverPath);
        
        // Dossier pour les fichiers par channel
        const byChannelPath = path.join(serverPath, "_Par_Channel");
        ensureDir(byChannelPath);
        
        // Dossier pour les fichiers par catégorie
        const byCategoryPath = path.join(serverPath, "_Par_Categorie");
        ensureDir(byCategoryPath);
        
        // Stats par catégorie
        const categoryStats: { [key: string]: number } = {};
        Object.values(CATEGORIES).forEach(cat => { categoryStats[cat] = 0; });
        
        // Messages groupés par catégorie pour ce serveur
        const messagesByCategory: { [key: string]: Array<{
            channelName: string;
            author: string;
            authorId: string;
            content: string;
            timestamp: string;
            attachments: string[];
            id: string;
        }> } = {};
        Object.values(CATEGORIES).forEach(cat => { messagesByCategory[cat] = []; });
        
        // Traiter chaque channel
        for (const channelData of channelsData) {
            const channelFileName = sanitize(channelData.channelName) + "_" + channelData.messages.length + "msgs.txt";
            const channelFilePath = path.join(byChannelPath, channelFileName);
            
            let fileContent = "=".repeat(60) + "\n";
            fileContent += "CHANNEL: #" + channelData.channelName + "\n";
            fileContent += "Channel ID: " + channelData.channelId + "\n";
            fileContent += "Server: " + guildName + "\n";
            fileContent += "Date du dump: " + new Date().toLocaleString() + "\n";
            fileContent += "Nombre de messages: " + channelData.messages.length + "\n";
            fileContent += "=".repeat(60) + "\n\n";
            
            // Messages du plus ancien au plus récent
            const sortedMessages = [...channelData.messages].reverse();
            
            for (const msg of sortedMessages) {
                // Catégoriser le message (sync pour la rapidité)
                const category = categorizeMessageSync(msg.content, msg.attachments);
                categoryStats[category]++;
                
                // Ajouter aux messages par catégorie
                messagesByCategory[category].push({
                    channelName: channelData.channelName,
                    ...msg
                });
                
                fileContent += "[" + msg.timestamp + "] [" + category + "] " + msg.author + " (" + msg.authorId + "):\n";
                fileContent += msg.content || "[empty]";
                fileContent += "\n";
                
                if (msg.attachments.length > 0) {
                    fileContent += "📎 Attachments: " + msg.attachments.join(", ") + "\n";
                }
                
                fileContent += "-".repeat(40) + "\n";
            }
            
            fs.writeFileSync(channelFilePath, fileContent, "utf8");
        }
        
        // Créer les fichiers par catégorie
        for (const [category, messages] of Object.entries(messagesByCategory)) {
            if (messages.length === 0) continue;
            
            const categoryPath = path.join(byCategoryPath, sanitize(category));
            ensureDir(categoryPath);
            
            const categoryFileName = sanitize(category) + "_" + messages.length + "msgs.txt";
            const categoryFilePath = path.join(categoryPath, categoryFileName);
            
            let catContent = "=".repeat(60) + "\n";
            catContent += "CATÉGORIE: " + category + "\n";
            catContent += "Server: " + guildName + "\n";
            catContent += "Date du dump: " + new Date().toLocaleString() + "\n";
            catContent += "Nombre de messages: " + messages.length + "\n";
            catContent += "=".repeat(60) + "\n\n";
            
            for (const msg of messages) {
                catContent += "[" + msg.timestamp + "] #" + msg.channelName + " | " + msg.author + ":\n";
                catContent += msg.content || "[empty]";
                catContent += "\n";
                
                if (msg.attachments.length > 0) {
                    catContent += "📎 Attachments: " + msg.attachments.join(", ") + "\n";
                }
                
                catContent += "-".repeat(40) + "\n";
            }
            
            fs.writeFileSync(categoryFilePath, catContent, "utf8");
        }
        
        // Créer un fichier résumé pour le serveur
        const summaryPath = path.join(serverPath, "_SUMMARY.txt");
        let summaryContent = "=".repeat(60) + "\n";
        summaryContent += "SERVER DUMP SUMMARY\n";
        summaryContent += "=".repeat(60) + "\n";
        summaryContent += "Server: " + guildName + "\n";
        summaryContent += "Server ID: " + guildId + "\n";
        summaryContent += "Date: " + new Date().toLocaleString() + "\n";
        summaryContent += "Total channels: " + channelsData.length + "\n";
        summaryContent += "Total messages: " + totalMessages + "\n";
        summaryContent += "=".repeat(60) + "\n\n";
        
        summaryContent += "📊 STATISTIQUES PAR CATÉGORIE:\n";
        const icons: { [key: string]: string } = {
            "Images": "🖼️",
            "Videos": "🎬",
            "Commandes": "⌨️",
            "Infos_Personnelles": "🔐",
            "Inapproprie": "🔞",
            "Liens": "🔗",
            "Fichiers": "📄",
            "Conversations": "💬"
        };
        for (const [cat, count] of Object.entries(categoryStats)) {
            if (count > 0) {
                summaryContent += (icons[cat] || "•") + " " + cat + ": " + count + " messages\n";
            }
        }
        
        summaryContent += "\n📺 CHANNELS:\n";
        for (const channelData of channelsData) {
            summaryContent += "• #" + channelData.channelName + ": " + channelData.messages.length + " messages\n";
        }
        
        fs.writeFileSync(summaryPath, summaryContent, "utf8");
        
        return { success: true, path: serverPath, categoryStats };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}

export function openFolder(_: IpcMainInvokeEvent, subPath?: string): { success: boolean } {
    try {
        const targetPath = subPath ? path.join(BASE_PATH, subPath) : BASE_PATH;
        ensureDir(targetPath);
        exec("explorer \"" + targetPath + "\"");
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

export function getStats(_: IpcMainInvokeEvent): {
    totalFiles: number;
    totalSize: string;
    exists: boolean;
} {
    try {
        if (!fs.existsSync(BASE_PATH)) {
            return { totalFiles: 0, totalSize: "0 KB", exists: false };
        }
        
        let totalFiles = 0;
        let totalSize = 0;
        
        const countDir = (dir: string) => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const itemPath = path.join(dir, item);
                const stat = fs.statSync(itemPath);
                if (stat.isDirectory()) {
                    countDir(itemPath);
                } else {
                    totalFiles++;
                    totalSize += stat.size;
                }
            }
        };
        
        countDir(BASE_PATH);
        
        const sizeStr = totalSize > 1024 * 1024 
            ? (totalSize / (1024 * 1024)).toFixed(2) + " MB"
            : (totalSize / 1024).toFixed(2) + " KB";
        
        return { totalFiles, totalSize: sizeStr, exists: true };
    } catch (error) {
        return { totalFiles: 0, totalSize: "0 KB", exists: false };
    }
}

export function getCategories(_: IpcMainInvokeEvent): { categories: string[] } {
    return { categories: Object.values(CATEGORIES) };
}
