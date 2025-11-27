import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ChannelStore, GuildStore, showToast, Toasts, UserStore } from "@webpack/common";

const logger = new Logger("MessageCollector");
const Native = VencordNative.pluginHelpers.MessageCollector as PluginNative<typeof import("./native")>;

let isCollecting = false;
let messageCount = 0;

interface Message {
    id: string;
    channel_id: string;
    author: {
        id: string;
        username: string;
        discriminator?: string;
    };
    content: string;
    timestamp: string;
    attachments?: Array<{ url: string }>;
}

async function handleMessage(message: Message): Promise<void> {
    if (!isCollecting) return;
    
    try {
        const channel = ChannelStore.getChannel(message.channel_id);
        if (!channel) return;
        
        const currentUser = UserStore.getCurrentUser();
        if (!currentUser) return;
        
        const accountName = currentUser.username;
        const authorName = message.author.username;
        
        let serverName: string;
        let channelName: string;
        
        if (channel.guild_id) {
            const guild = GuildStore.getGuild(channel.guild_id);
            if (!guild) return;
            serverName = guild.name;
            channelName = channel.name || "unknown";
        } else {
            if (channel.type === 1) {
                serverName = "DMs";
                channelName = "DM_" + message.author.username;
            } else if (channel.type === 3) {
                serverName = "Group_DMs";
                channelName = channel.name || "Group_" + channel.id;
            } else {
                serverName = "Other";
                channelName = "Channel_" + channel.id;
            }
        }
        
        const timestamp = new Date(message.timestamp).toLocaleString("en-US", {
            year: "numeric",
            month: "2-digit", 
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });
        
        const content = message.content || "";
        const attachments = message.attachments?.map((a) => a.url) || [];
        
        const result = await Native.saveMessage(
            accountName,
            serverName,
            authorName,
            timestamp,
            content,
            attachments,
            message.id,
            channelName
        );
        
        if (result.success) {
            messageCount++;
        } else {
            showToast("Save error: " + result.error, Toasts.Type.FAILURE);
        }
        
    } catch (error) {
        logger.error("Collection error:", error);
    }
}

export default definePlugin({
    name: "MessageCollector",
    description: "Collects and saves messages to C:\\DiscordMessages",
    authors: [Devs.Ven],
    
    options: {
        autoCollect: {
            type: OptionType.BOOLEAN,
            description: "Start collecting automatically on launch",
            default: false
        }
    },
    
    commands: [
        {
            name: "collector-start",
            description: "Start collecting messages",
            execute: async () => {
                isCollecting = true;
                const initResult = await Native.initFolder();
                showToast("Collection started", Toasts.Type.SUCCESS);
                return {
                    send: false,
                    result: "Collection enabled\nFolder: " + initResult.path
                };
            }
        },
        {
            name: "collector-stop",
            description: "Stop collecting messages",
            execute: () => {
                isCollecting = false;
                showToast("Collection stopped (" + messageCount + " msgs)", Toasts.Type.MESSAGE);
                return {
                    send: false,
                    result: "Collection disabled\nMessages collected: " + messageCount
                };
            }
        },
        {
            name: "collector-stats",
            description: "Show statistics",
            execute: async () => {
                const stats = await Native.getStats();
                const status = isCollecting ? "Active" : "Inactive";
                showToast(stats.totalFiles + " files | " + status, Toasts.Type.MESSAGE);
                return {
                    send: false,
                    result: "Session: " + messageCount + " msgs\nTotal files: " + stats.totalFiles + "\nStatus: " + status
                };
            }
        },
        {
            name: "collector-open",
            description: "Open save folder",
            execute: async () => {
                const result = await Native.openFolder();
                if (result.success) {
                    showToast("Folder opened", Toasts.Type.SUCCESS);
                } else {
                    showToast("Could not open folder", Toasts.Type.FAILURE);
                }
                return {
                    send: false,
                    result: "Opening C:\\DiscordMessages"
                };
            }
        },
        {
            name: "collector-test",
            description: "Test if plugin works",
            execute: async () => {
                try {
                    const stats = await Native.getStats();
                    showToast("Plugin OK", Toasts.Type.SUCCESS);
                    return {
                        send: false,
                        result: "Native communication: OK\nFolder exists: " + stats.exists + "\nFiles: " + stats.totalFiles
                    };
                } catch (error) {
                    showToast("Plugin error", Toasts.Type.FAILURE);
                    return {
                        send: false,
                        result: "Error: " + error
                    };
                }
            }
        }
    ],
    
    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: Message; optimistic: boolean; }) {
            if (optimistic) return;
            if (message) handleMessage(message);
        }
    },
    
    async start() {
        await Native.initFolder();
        if (this.settings?.store?.autoCollect) {
            isCollecting = true;
            showToast("Auto-collection enabled", Toasts.Type.SUCCESS);
        }
    },
    
    stop() {
        isCollecting = false;
    }
});
