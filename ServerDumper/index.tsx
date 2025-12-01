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

let globalCategoryStats: { [key: string]: number } = {};

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
    if (channelsProcessedTotal === 0) return "Calculating...";
    
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
                    showToast(`⏳ Rate limit - Waiting ${waitTime}s...`, Toasts.Type.MESSAGE);
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
        return "⏳ A dump is already in progress... Use /dump-stop to stop it.";
    }
    
    isDumping = true;
    shouldStop = false;
    globalCategoryStats = {};
    startTime = Date.now();
    channelsProcessedTotal = 0;
    
    const token = getToken();
    if (!token) {
        isDumping = false;
        return "❌ Unable to retrieve authentication token.";
    }
    
    const guilds = getAllGuilds();
    if (guilds.length === 0) {
        isDumping = false;
        return "❌ No servers found.";
    }
    
    const useAI = pluginSettings?.store?.useAI ?? false;
    
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
        estimatedTimeLeft: "Calculating..."
    };
    
    showToast(`🚀 Dumping ${guilds.length} servers (${totalChannelsToProcess} channels)...`, Toasts.Type.MESSAGE);
    
    let totalMessagesCollected = 0;
    let serversProcessed = 0;
    
    try {
        for (const guild of guilds) {
            if (shouldStop) {
                showToast("⏹️ Dump stopped by user", Toasts.Type.MESSAGE);
                break;
            }
            
            progress.currentGuild++;
            progress.currentGuildName = guild.name;
            
            const channels = getTextChannels(guild.id);
            progress.totalChannels = channels.length;
            progress.currentChannel = 0;
            
            updateProgress();
            
            showToast(
                `📥 [${progress.currentGuild}/${progress.totalGuilds}] ${guild.name} | ${progress.percentComplete}% | ⏱️ ${progress.estimatedTimeLeft}`,
                Toasts.Type.MESSAGE
            );
            
            logger.info(`Processing guild: ${guild.name} (${guild.id})`);
            
            if (channels.length === 0) {
                logger.info(`No text channels found in ${guild.name}`);
                continue;
            }
            
            const guildCategoryStats: { [key: string]: number } = {};
            const channelsInfo: Array<{ channelName: string; messageCount: number }> = [];
            let totalMsgsInGuild = 0;
            
            for (const channel of channels) {
                if (shouldStop) break;
                
                progress.currentChannel++;
                progress.currentChannelName = channel.name;
                
                showToast(
                    `📺 #${channel.name} (${progress.currentChannel}/${progress.totalChannels}) | 💬 ${progress.totalMessages} msgs`,
                    Toasts.Type.MESSAGE
                );
                
                logger.info(`  Fetching #${channel.name} (${channel.id})...`);
                
                const messages = await fetchMessagesFromChannel(channel.id, token);
                
                if (messages.length > 0) {
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
                    
                    showToast(`💾 Saving #${channel.name} (${messages.length} msgs)...`, Toasts.Type.MESSAGE);
                    
                    const result = await Native.saveChannelToGuildDump(
                        accountName,
                        guild.name,
                        guild.id,
                        channel.name,
                        channel.id,
                        formattedMessages,
                        useAI
                    );
                    
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
                    
                    if (messages.length > 1000) {
                        showToast(`✅ #${channel.name}: ${messages.length} messages saved!`, Toasts.Type.SUCCESS);
                    }
                }
                
                channelsProcessedTotal++;
                updateProgress();
                
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            
            if (channelsInfo.length > 0) {
                showToast(`📝 Finalizing summary for ${guild.name}...`, Toasts.Type.MESSAGE);
                
                await Native.finalizeGuildDumpSummary(
                    guild.name,
                    guild.id,
                    channelsInfo,
                    totalMsgsInGuild,
                    guildCategoryStats
                );
                
                serversProcessed++;
                
                showToast(`✅ ${guild.name} completed! | ${progress.percentComplete}% global`, Toasts.Type.SUCCESS);
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        const duration = Math.round((Date.now() - startTime) / 1000);
        const durationStr = formatDuration(duration);
        
        isDumping = false;
        
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
            return `⏹️ **Dump stopped!**\n\n📊 **Statistics:**\n• Messages: ${totalMessagesCollected}\n• Servers: ${serversProcessed}/${guilds.length}\n• Channels: ${channelsProcessedTotal}/${totalChannelsToProcess}\n• Duration: ${durationStr}\n\n📑 **By category:**\n${categoryReport}`;
        }
        
        showToast(`🎉 Dump completed! ${totalMessagesCollected} messages in ${durationStr}`, Toasts.Type.SUCCESS);
        await Native.openFolder();
        
        return `✅ **Dump completed!**\n\n📊 **Statistics:**\n• Servers: ${serversProcessed}/${guilds.length}\n• Channels: ${channelsProcessedTotal}\n• Messages: ${totalMessagesCollected}\n• Duration: ${durationStr}\n\n📑 **By category:**\n${categoryReport}\n📁 Saved in C:\\DiscordServerDumps`;
        
    } catch (error) {
        logger.error("Dump error:", error);
        isDumping = false;
        return `❌ Error during dump: ${error}`;
    }
}

export default definePlugin({
    name: "ServerDumper",
    description: "Downloads ALL messages from ALL servers with automatic categorization (Images, Videos, Links, etc.)",
    authors: [Devs.Ven],
    
    options: {
        useAI: {
            type: OptionType.BOOLEAN,
            description: "Use AI to classify ambiguous messages (Pollinations API) - Slower but more accurate",
            default: false
        }
    },
    
    commands: [
        {
            name: "dump-all-servers",
            description: "Download all messages from all servers with categorization (⚠️ very long)",
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
            description: "Stop the current dump",
            execute: () => {
                if (!isDumping) {
                    return {
                        send: false,
                        result: "ℹ️ No dump in progress."
                    };
                }
                shouldStop = true;
                return {
                    send: false,
                    result: "⏹️ Stop requested... The dump will stop after the current channel."
                };
            }
        },
        {
            name: "dump-progress",
            description: "Show detailed dump progress",
            execute: () => {
                if (!isDumping) {
                    return {
                        send: false,
                        result: "ℹ️ No dump in progress."
                    };
                }
                
                updateProgress();
                
                const elapsed = formatDuration((Date.now() - startTime) / 1000);
                
                let result = "📊 **Dump Progress:**\n\n";
                result += `📈 **${progress.percentComplete}%** completed\n`;
                result += `⏱️ Elapsed time: ${elapsed}\n`;
                result += `⏳ Estimated time remaining: ${progress.estimatedTimeLeft}\n\n`;
                result += `🏠 Server: **${progress.currentGuild}/${progress.totalGuilds}** - ${progress.currentGuildName}\n`;
                result += `📺 Channel: **${progress.currentChannel}/${progress.totalChannels}** - #${progress.currentChannelName}\n`;
                result += `📺 Total channels: **${channelsProcessedTotal}/${totalChannelsToProcess}**\n`;
                result += `💬 Messages collected: **${progress.totalMessages}**\n\n`;
                
                if (Object.keys(globalCategoryStats).length > 0) {
                    result += "📑 **By category:**\n";
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
            description: "Open the server dumps folder",
            execute: async () => {
                await Native.openFolder();
                return {
                    send: false,
                    result: "📂 Opening C:\\DiscordServerDumps"
                };
            }
        },
        {
            name: "dump-servers-list",
            description: "List all available servers",
            execute: () => {
                const guilds = getAllGuilds();
                let totalChannels = 0;
                let result = `📋 **${guilds.length} servers found:**\n\n`;
                
                guilds.forEach((guild, index) => {
                    const channels = getTextChannels(guild.id);
                    totalChannels += channels.length;
                    result += `${index + 1}. **${guild.name}** (${channels.length} channels)\n`;
                });
                
                result += `\n📊 **Total: ${totalChannels} channels to dump**`;
                
                return {
                    send: false,
                    result: result
                };
            }
        },
        {
            name: "dump-categories",
            description: "Show available categories",
            execute: async () => {
                const cats = await Native.getCategories();
                let result = "📑 **Sorting categories:**\n\n";
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
                
                result += "\n💡 Messages are automatically sorted into these categories!";
                
                return {
                    send: false,
                    result: result
                };
            }
        },
        {
            name: "dump-servers-test",
            description: "Test if the plugin works",
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
                    
                    const estimatedMinutes = Math.round((totalChannels * 4) / 60);
                    const estimatedTime = estimatedMinutes > 60 
                        ? `${Math.floor(estimatedMinutes / 60)}h ${estimatedMinutes % 60}m`
                        : `${estimatedMinutes}m`;
                    
                    let result = "🔍 **ServerDumper Test**\n\n";
                    result += `📁 Folder: ${initResult.success ? "✅ OK" : "❌ ERROR"}\n`;
                    result += `📁 Path: ${initResult.path}\n`;
                    result += `🔑 Token: ${tokenOk ? "✅ OK" : "❌ ERROR"}\n`;
                    result += `🏠 Servers: **${guilds.length}**\n`;
                    result += `📺 Total channels: **${totalChannels}**\n`;
                    result += `🤖 AI enabled: ${useAI ? "✅ Yes" : "❌ No"}\n`;
                    result += `⏱️ Estimated time: **~${estimatedTime}**\n`;
                    
                    if (tokenOk && guilds.length > 0) {
                        result += "\n✅ **Everything is OK!** You can use /dump-all-servers";
                        result += "\n\n📑 Messages will be automatically sorted by category.";
                        result += "\n📊 Use /dump-progress to track progress!";
                    } else {
                        result += "\n❌ **Problem detected** - Check the errors above";
                    }
                    
                    showToast("Test completed", Toasts.Type.SUCCESS);
                    return { send: false, result: result };
                } catch (error) {
                    return { send: false, result: "❌ Error: " + error };
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
