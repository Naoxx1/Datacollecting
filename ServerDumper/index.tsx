import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ChannelStore, GuildStore, showToast, Toasts, UserStore } from "@webpack/common";
import { findByProps } from "@webpack";

const logger = new Logger("ServerDumper");
const Native = VencordNative.pluginHelpers.ServerDumper as PluginNative<typeof import("./native")>;

let isDumping = false;
let shouldStop = false;
let pluginSettings: any = null;

// Stats globales par catégorie
let globalCategoryStats: { [key: string]: number } = {};

// Pour le calcul du temps estimé
let startTime = 0;
let channelsProcessedTotal = 0;
let totalChannelsToProcess = 0;

interface Message {
    id: string;
    author: {
        username: string;
        id: string;
    };
    content: string;
    timestamp: string;
    attachments?: Array<{ url: string }>;
}

interface Channel {
    id: string;
    name: string;
    type: number;
    guild_id?: string;
    position?: number;
}

interface Guild {
    id: string;
    name: string;
}

interface DumpProgress {
    totalGuilds: number;
    currentGuild: number;
    currentGuildName: string;
    totalChannels: number;
    currentChannel: number;
    currentChannelName: string;
    totalMessages: number;
    percentComplete: number;
    estimatedTimeLeft: string;
}

let progress: DumpProgress = {
    totalGuilds: 0,
    currentGuild: 0,
    currentGuildName: "",
    totalChannels: 0,
    currentChannel: 0,
    currentChannelName: "",
    totalMessages: 0,
    percentComplete: 0,
    estimatedTimeLeft: "Calcul..."
};

function getToken(): string {
    try {
        const AuthStore = findByProps("getToken", "getFingerprint");
        if (AuthStore?.getToken) {
            return AuthStore.getToken();
        }
    } catch (e) {
        logger.error("getToken error:", e);
    }
    return "";
}

function formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return `${mins}m ${secs}s`;
    }
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
}

function calculateEstimatedTime(): string {
    if (channelsProcessedTotal === 0) return "Calcul...";
    
    const elapsed = (Date.now() - startTime) / 1000;
    const avgTimePerChannel = elapsed / channelsProcessedTotal;
    const remainingChannels = totalChannelsToProcess - channelsProcessedTotal;
    const estimatedRemaining = avgTimePerChannel * remainingChannels;
    
    return formatDuration(estimatedRemaining);
}

function updateProgress() {
    progress.percentComplete = totalChannelsToProcess > 0 
        ? Math.round((channelsProcessedTotal / totalChannelsToProcess) * 100) 
        : 0;
    progress.estimatedTimeLeft = calculateEstimatedTime();
}

async function fetchMessagesFromChannel(channelId: string, token: string, maxMessages?: number): Promise<Message[]> {
    const messages: Message[] = [];
    let lastMessageId: string | undefined;
    let batchCount = 0;
    
    try {
        while (!shouldStop) {
            const url = `https://discord.com/api/v9/channels/${channelId}/messages?limit=100${lastMessageId ? `&before=${lastMessageId}` : ""}`;
            
            const response = await fetch(url, {
                headers: {
                    "Authorization": token,
                    "Content-Type": "application/json"
                }
            });
            
            if (!response.ok) {
                if (response.status === 429) {
                    const retryAfter = response.headers.get("Retry-After") || "5";
                    const waitTime = parseInt(retryAfter);
                    showToast(`⏳ Rate limit - Pause ${waitTime}s...`, Toasts.Type.MESSAGE);
                    logger.info(`Rate limit, waiting ${retryAfter}s...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime * 1000 + 500));
                    continue;
                }
                if (response.status === 403) {
                    logger.info(`No access to channel ${channelId}`);
                    break;
                }
                logger.error("Fetch error:", response.status);
                break;
            }
            
            const batch: Message[] = await response.json();
            
            if (batch.length === 0) break;
            
            messages.push(...batch);
            lastMessageId = batch[batch.length - 1].id;
            batchCount++;
            
            // Notification tous les 500 messages dans un channel
            if (messages.length % 500 === 0) {
                showToast(`📨 #${progress.currentChannelName}: ${messages.length} msgs...`, Toasts.Type.MESSAGE);
            }
            
            if (maxMessages && messages.length >= maxMessages) {
                break;
            }
            
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    } catch (error) {
        logger.error(`Error fetching messages from channel ${channelId}:`, error);
    }
    
    return messages;
}

function getTextChannels(guildId: string): Channel[] {
    const channels: Channel[] = [];
    
    const guildChannels = ChannelStore.getMutableGuildChannelsForGuild?.(guildId);
    
    if (guildChannels) {
        for (const channelId in guildChannels) {
            const channel = guildChannels[channelId];
            if (channel && (channel.type === 0 || channel.type === 5)) {
                channels.push({
                    id: channel.id,
                    name: channel.name || "unknown",
                    type: channel.type,
                    guild_id: channel.guild_id,
                    position: channel.position
                });
            }
        }
    }
    
    channels.sort((a, b) => (a.position || 0) - (b.position || 0));
    
    return channels;
}

function getAllGuilds(): Guild[] {
    const guilds: Guild[] = [];
    const guildStore = GuildStore.getGuilds?.() || {};
    
    for (const guildId in guildStore) {
        const guild = guildStore[guildId];
        if (guild) {
            guilds.push({
                id: guild.id,
                name: guild.name || "Unknown Server"
            });
        }
    }
    
    return guilds;
}

async function dumpAllServers(): Promise<string> {
    if (isDumping) {
        return "⏳ Un dump est déjà en cours... Utilise /dump-stop pour l'arrêter.";
    }
    
    isDumping = true;
    shouldStop = false;
    globalCategoryStats = {};
    startTime = Date.now();
    channelsProcessedTotal = 0;
    
    const token = getToken();
    if (!token) {
        isDumping = false;
        return "❌ Impossible de récupérer le token d'authentification.";
    }
    
    const guilds = getAllGuilds();
    if (guilds.length === 0) {
        isDumping = false;
        return "❌ Aucun serveur trouvé.";
    }
    
    const useAI = pluginSettings?.store?.useAI ?? false;
    
    // Calculer le nombre total de channels
    totalChannelsToProcess = 0;
    for (const guild of guilds) {
        totalChannelsToProcess += getTextChannels(guild.id).length;
    }
    
    progress = {
        totalGuilds: guilds.length,
        currentGuild: 0,
        currentGuildName: "",
        totalChannels: 0,
        currentChannel: 0,
        currentChannelName: "",
        totalMessages: 0,
        percentComplete: 0,
        estimatedTimeLeft: "Calcul..."
    };
    
    showToast(`🚀 Dump de ${guilds.length} serveurs (${totalChannelsToProcess} channels)...`, Toasts.Type.MESSAGE);
    
    let totalMessagesCollected = 0;
    let serversProcessed = 0;
    
    try {
        for (const guild of guilds) {
            if (shouldStop) {
                showToast("⏹️ Dump arrêté par l'utilisateur", Toasts.Type.MESSAGE);
                break;
            }
            
            progress.currentGuild++;
            progress.currentGuildName = guild.name;
            
            const channels = getTextChannels(guild.id);
            progress.totalChannels = channels.length;
            progress.currentChannel = 0;
            
            updateProgress();
            
            // Notification avec pourcentage et temps estimé
            showToast(
                `📥 [${progress.currentGuild}/${progress.totalGuilds}] ${guild.name} | ${progress.percentComplete}% | ⏱️ ${progress.estimatedTimeLeft}`,
                Toasts.Type.MESSAGE
            );
            
            logger.info(`Processing guild: ${guild.name} (${guild.id})`);
            
            if (channels.length === 0) {
                logger.info(`No text channels found in ${guild.name}`);
                continue;
            }
            
            // Stats de catégories pour ce serveur
            const guildCategoryStats: { [key: string]: number } = {};
            const channelsInfo: Array<{ channelName: string; messageCount: number }> = [];
            let totalMsgsInGuild = 0;
            
            for (const channel of channels) {
                if (shouldStop) break;
                
                progress.currentChannel++;
                progress.currentChannelName = channel.name;
                
                // Notification pour chaque channel
                showToast(
                    `📺 #${channel.name} (${progress.currentChannel}/${progress.totalChannels}) | 💬 ${progress.totalMessages} msgs`,
                    Toasts.Type.MESSAGE
                );
                
                logger.info(`  Fetching #${channel.name} (${channel.id})...`);
                
                const messages = await fetchMessagesFromChannel(channel.id, token);
                
                if (messages.length > 0) {
                    // Récupérer le nom du compte actuel
                    const currentUser = UserStore.getCurrentUser();
                    const accountName = currentUser?.username || "Unknown";
                    
                    const formattedMessages = messages.map(msg => ({
                        author: msg.author.username,
                        authorId: msg.author.id,
                        content: msg.content,
                        timestamp: new Date(msg.timestamp).toLocaleString("en-US", {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit"
                        }),
                        attachments: msg.attachments?.map(a => a.url) || [],
                        id: msg.id
                    }));
                    
                    totalMessagesCollected += messages.length;
                    totalMsgsInGuild += messages.length;
                    progress.totalMessages = totalMessagesCollected;
                    
                    // Sauvegarder immédiatement le channel (chaque message individuellement)
                    showToast(`💾 Sauvegarde de #${channel.name} (${messages.length} msgs)...`, Toasts.Type.MESSAGE);
                    
                    const result = await Native.saveChannelToGuildDump(
                        accountName,
                        guild.name,
                        guild.id,
                        channel.name,
                        channel.id,
                        formattedMessages,
                        useAI
                    );
                    
                    // Agréger les stats de catégories
                    if (result.categoryStats) {
                        for (const [cat, count] of Object.entries(result.categoryStats)) {
                            guildCategoryStats[cat] = (guildCategoryStats[cat] || 0) + count;
                            globalCategoryStats[cat] = (globalCategoryStats[cat] || 0) + count;
                        }
                    }
                    
                    channelsInfo.push({
                        channelName: channel.name,
                        messageCount: messages.length
                    });
                    
                    // Notification si beaucoup de messages dans ce channel
                    if (messages.length > 1000) {
                        showToast(`✅ #${channel.name}: ${messages.length} messages sauvegardés!`, Toasts.Type.SUCCESS);
                    }
                }
                
                channelsProcessedTotal++;
                updateProgress();
                
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            
            // Finaliser le résumé du serveur
            if (channelsInfo.length > 0) {
                showToast(`📝 Finalisation du résumé de ${guild.name}...`, Toasts.Type.MESSAGE);
                
                await Native.finalizeGuildDumpSummary(
                    guild.name,
                    guild.id,
                    channelsInfo,
                    totalMsgsInGuild,
                    guildCategoryStats
                );
                
                serversProcessed++;
                
                showToast(`✅ ${guild.name} terminé! | ${progress.percentComplete}% global`, Toasts.Type.SUCCESS);
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        const duration = Math.round((Date.now() - startTime) / 1000);
        const durationStr = formatDuration(duration);
        
        isDumping = false;
        
        // Construire le résumé des catégories
        let categoryReport = "";
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
        
        for (const [cat, count] of Object.entries(globalCategoryStats)) {
            if (count > 0) {
                categoryReport += `${icons[cat] || "•"} ${cat}: ${count}\n`;
            }
        }
        
        if (shouldStop) {
            return `⏹️ **Dump arrêté!**\n\n📊 **Statistiques:**\n• Messages: ${totalMessagesCollected}\n• Serveurs: ${serversProcessed}/${guilds.length}\n• Channels: ${channelsProcessedTotal}/${totalChannelsToProcess}\n• Durée: ${durationStr}\n\n📑 **Par catégorie:**\n${categoryReport}`;
        }
        
        showToast(`🎉 Dump terminé! ${totalMessagesCollected} messages en ${durationStr}`, Toasts.Type.SUCCESS);
        await Native.openFolder();
        
        return `✅ **Dump complet terminé!**\n\n📊 **Statistiques:**\n• Serveurs: ${serversProcessed}/${guilds.length}\n• Channels: ${channelsProcessedTotal}\n• Messages: ${totalMessagesCollected}\n• Durée: ${durationStr}\n\n📑 **Par catégorie:**\n${categoryReport}\n📁 Sauvegardé dans C:\\DiscordServerDumps`;
        
    } catch (error) {
        logger.error("Dump error:", error);
        isDumping = false;
        return `❌ Erreur lors du dump: ${error}`;
    }
}

export default definePlugin({
    name: "ServerDumper",
    description: "Télécharge TOUS les messages de TOUS les serveurs avec catégorisation automatique (Images, Vidéos, Liens, etc.)",
    authors: [Devs.Ven],
    
    options: {
        useAI: {
            type: OptionType.BOOLEAN,
            description: "Utiliser l'IA pour classifier les messages ambigus (Pollinations API) - Plus lent mais plus précis",
            default: false
        }
    },
    
    commands: [
        {
            name: "dump-all-servers",
            description: "Télécharger tous les messages de tous les serveurs avec catégorisation (⚠️ très long)",
            execute: async () => {
                const result = await dumpAllServers();
                return {
                    send: false,
                    result: result
                };
            }
        },
        {
            name: "dump-stop",
            description: "Arrêter le dump en cours",
            execute: () => {
                if (!isDumping) {
                    return {
                        send: false,
                        result: "ℹ️ Aucun dump en cours."
                    };
                }
                shouldStop = true;
                return {
                    send: false,
                    result: "⏹️ Arrêt du dump demandé... Le dump s'arrêtera après le channel en cours."
                };
            }
        },
        {
            name: "dump-progress",
            description: "Afficher la progression détaillée du dump",
            execute: () => {
                if (!isDumping) {
                    return {
                        send: false,
                        result: "ℹ️ Aucun dump en cours."
                    };
                }
                
                updateProgress();
                
                const elapsed = formatDuration((Date.now() - startTime) / 1000);
                
                let result = "📊 **Progression du dump:**\n\n";
                result += `📈 **${progress.percentComplete}%** complété\n`;
                result += `⏱️ Temps écoulé: ${elapsed}\n`;
                result += `⏳ Temps restant estimé: ${progress.estimatedTimeLeft}\n\n`;
                result += `🏠 Serveur: **${progress.currentGuild}/${progress.totalGuilds}** - ${progress.currentGuildName}\n`;
                result += `📺 Channel: **${progress.currentChannel}/${progress.totalChannels}** - #${progress.currentChannelName}\n`;
                result += `📺 Channels total: **${channelsProcessedTotal}/${totalChannelsToProcess}**\n`;
                result += `💬 Messages collectés: **${progress.totalMessages}**\n\n`;
                
                if (Object.keys(globalCategoryStats).length > 0) {
                    result += "📑 **Par catégorie:**\n";
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
                    for (const [cat, count] of Object.entries(globalCategoryStats)) {
                        if (count > 0) {
                            result += `${icons[cat] || "•"} ${cat}: ${count}\n`;
                        }
                    }
                }
                
                return {
                    send: false,
                    result: result
                };
            }
        },
        {
            name: "dump-servers-open",
            description: "Ouvrir le dossier des dumps serveurs",
            execute: async () => {
                await Native.openFolder();
                return {
                    send: false,
                    result: "📂 Ouverture de C:\\DiscordServerDumps"
                };
            }
        },
        {
            name: "dump-servers-list",
            description: "Lister tous les serveurs disponibles",
            execute: () => {
                const guilds = getAllGuilds();
                let totalChannels = 0;
                let result = `📋 **${guilds.length} serveurs trouvés:**\n\n`;
                
                guilds.forEach((guild, index) => {
                    const channels = getTextChannels(guild.id);
                    totalChannels += channels.length;
                    result += `${index + 1}. **${guild.name}** (${channels.length} channels)\n`;
                });
                
                result += `\n📊 **Total: ${totalChannels} channels à dumper**`;
                
                return {
                    send: false,
                    result: result
                };
            }
        },
        {
            name: "dump-categories",
            description: "Afficher les catégories disponibles",
            execute: async () => {
                const cats = await Native.getCategories();
                let result = "📑 **Catégories de tri:**\n\n";
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
                cats.categories.forEach(cat => {
                    result += `${icons[cat] || "•"} **${cat}**\n`;
                });
                
                result += "\n💡 Les messages sont automatiquement triés dans ces catégories!";
                
                return {
                    send: false,
                    result: result
                };
            }
        },
        {
            name: "dump-servers-test",
            description: "Tester si le plugin fonctionne",
            execute: async () => {
                try {
                    const initResult = await Native.initFolder();
                    const token = getToken();
                    const tokenOk = token && token.length > 10;
                    const guilds = getAllGuilds();
                    const useAI = pluginSettings?.store?.useAI ?? false;
                    
                    let totalChannels = 0;
                    guilds.forEach(g => {
                        totalChannels += getTextChannels(g.id).length;
                    });
                    
                    // Estimation du temps (environ 3-5 secondes par channel en moyenne)
                    const estimatedMinutes = Math.round((totalChannels * 4) / 60);
                    const estimatedTime = estimatedMinutes > 60 
                        ? `${Math.floor(estimatedMinutes / 60)}h ${estimatedMinutes % 60}m`
                        : `${estimatedMinutes}m`;
                    
                    let result = "🔍 **Test ServerDumper**\n\n";
                    result += `📁 Dossier: ${initResult.success ? "✅ OK" : "❌ ERREUR"}\n`;
                    result += `📁 Path: ${initResult.path}\n`;
                    result += `🔑 Token: ${tokenOk ? "✅ OK" : "❌ ERREUR"}\n`;
                    result += `🏠 Serveurs: **${guilds.length}**\n`;
                    result += `📺 Total channels: **${totalChannels}**\n`;
                    result += `🤖 IA activée: ${useAI ? "✅ Oui" : "❌ Non"}\n`;
                    result += `⏱️ Temps estimé: **~${estimatedTime}**\n`;
                    
                    if (tokenOk && guilds.length > 0) {
                        result += "\n✅ **Tout est OK!** Tu peux utiliser /dump-all-servers";
                        result += "\n\n📑 Les messages seront triés par catégorie automatiquement.";
                        result += "\n📊 Utilise /dump-progress pour suivre l'avancement!";
                    } else {
                        result += "\n❌ **Problème détecté** - Vérifie les erreurs ci-dessus";
                    }
                    
                    showToast("Test terminé", Toasts.Type.SUCCESS);
                    return { send: false, result: result };
                } catch (error) {
                    return { send: false, result: "❌ Erreur: " + error };
                }
            }
        }
    ],
    
    start() {
        pluginSettings = this.settings;
        Native.initFolder();
        logger.info("ServerDumper started - Ready to dump all servers with categorization!");
    },
    
    stop() {
        isDumping = false;
        shouldStop = true;
    }
});
