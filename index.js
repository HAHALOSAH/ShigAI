import fs from 'fs';
import fetch from 'node-fetch';
import { Client, GatewayIntentBits } from 'discord.js';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import 'dotenv/config';

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

const initialPrompt = [
    {
        "role": "user",
        "parts": [
            {
                "text": "You are about to help a user in a support channel on a product called \"Vencord\". Vencord is a Discord client mod that allows users to customize the Discord client with plugins and themes. You will be given the FAQ and plugin list."
            },
            {
                "text": "FAQ:"
            },
            {
                "text": JSON.stringify(JSON.parse(fs.readFileSync('./prompt/faq.json')))
            },
            {
                "text": "Plugin list:"
            },
            {
                "text": JSON.stringify(JSON.parse(fs.readFileSync('./prompt/plugins.json')))
            },
            {
                "text": "Other notes:"
            },
            {
                "text": fs.readFileSync('./prompt/prompt.txt').toString()
            }
        ]
    }
];

const apiKey = process.env.GEMINI_API_KEY;
const discordToken = process.env.DISCORD_TOKEN;
const channelId = process.env.CHANNEL_ID;

const genAI = new GoogleGenerativeAI(apiKey);
const fileManager = new GoogleAIFileManager(apiKey);

const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
});

const generationConfig = {
    temperature: 1,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 8192,
    responseMimeType: "text/plain",
};

const chatSessions = new Map();
const busyChannels = new Set();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages
    ]
});

client.login(discordToken);

client.on('messageCreate', async message => {
    if (!message.mentions.has(client.user)) return;
    if (!chatSessions.has(message.channelId)) {
        if (message.channel.parentId !== channelId) return;
        chatSessions.set(message.channelId, model.startChat({
            generationConfig,
            history: JSON.parse(JSON.stringify(initialPrompt))
        }));
    }
    if (message.author.bot) return;
    await aiResponse(message);
});

async function aiResponse(message, content = message.content) {
    if (content.startsWith('--') || content.startsWith('//')) return;
    if (busyChannels.has(message.channelId)) return;
    busyChannels.add(message.channelId);

    console.log(`${message.author.name}: ${content}`);

    try {
        const { file, mimeType } = await handleAttachments(message);

        replaceMentionsAndChannels(content);

        const result = await chatSessions.get(message.channelId).sendMessage([
            `${message.author.username}: ${content}`,
            ...(file ? [{ fileData: { fileUri: file.uri, mimeType } }] : [])
        ]);

        processResponse(result, message);
    } catch (error) {
        handleErrorResponse(error, message);
    }
}

async function handleAttachments(message) {
    let file = null, mimeType = null;

    if (message.attachments.size > 0) {
        const attachment = message.attachments.first();
        const response = await fetch(attachment.url);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const name = attachment.name.replace(/\//g, '\\\/');
        const path = `./tmp/${name}`;
        fs.writeFileSync(path, buffer);
        file = await uploadToGemini(path, attachment.contentType);
        mimeType = attachment.contentType;
    }

    return { file, mimeType };
}

function replaceMentionsAndChannels(content) {
    content.replace(/<@([0-9]+)>/g, (match, id) => {
        if (client.users.cache.get(id)) {
            content = content.replace(match, `<@${client.users.cache.get(id).username}>`);
        }
    });
    content.replace(/<#([0-9]+)>/g, (match, id) => {
        if (client.channels.cache.get(id)) {
            content = content.replace(match, `<#${client.channels.cache.get(id).name}>`);
        }
    });
}

async function uploadToGemini(path, mimeType) {
    const uploadResult = await fileManager.uploadFile(path, {
        mimeType,
        displayName: path.split("/").pop(),
    });
    return uploadResult.file;
}

async function processResponse(result, message) {
    let reply = await result.response.text();
    let lockThread = false;

    if (reply.includes("lockThread()")) {
        reply = reply.replace("lockThread()", "");
        lockThread = true;
    }

    const reactRegex = /react\(.*?\)/g;
    const reactMatch = reply.match(reactRegex);

    if (reactMatch) {
        reactMatch.forEach(match => {
            const emoji = match.slice(6, -1);
            message.react(emoji).catch(() => {});
            reply = reply.replace(match, '');
        });
    }

    busyChannels.delete(message.channelId);

    reply = reply.replace(/https?:\/\/[^\s/$.?#].[^\s]*/g, match => `<${match}>`);

    if (reply.trim() !== "") {
        console.log(reply);
        await message.channel.send({
            content: reply.length > 2000 ? `${reply.slice(0, 2000 - 5)}(cut)` : reply,
            allowedMentions: { parse: [] }
        });
    }

    if (lockThread && message.channel.isThread()) {
        message.channel.setLocked(true);
    }
}

function handleErrorResponse(error, message) {
    console.error(error);
    message.channel.send("An error occurred while trying to generate a response. Please try again.");
    chatSessions.delete(message.channelId);
    busyChannels.delete(message.channelId);
}

client.on('threadCreate', async thread => {
    if (thread.parentId !== channelId) return;
    thread.join();
    try {
        await thread.send({
            embeds: [{
                title: "Welcome to the support channel!",
                description: "Please make sure you've read <#1257025907625951423>. If you have any questions, feel free to ping me or reply to my message, otherwise I won't respond. You can also attach images!",
                footer: { text: "Warning: AI generated responses may not be accurate." },
                color: 0xdd7878
            }]
        });
        chatSessions.set(thread.id, model.startChat({
            generationConfig,
            history: JSON.parse(JSON.stringify(initialPrompt))
        }));
        const messages = await thread.messages.fetch();
        const firstMessage = messages.first();
        if (firstMessage) {
            await aiResponse(firstMessage, `${thread.name}\n${firstMessage.content}`);
        }
    } catch (error) {
        console.error(error);
        thread.send("An error occurred while trying to generate a response. Please try again.");
    }
});
