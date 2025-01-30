/**
 * @fileoverview Yue Discord Bot
 * 
 * This file implements a single-conversation Discord bot named Yue. 
 * Yue responds to messages that mention certain keywords or the bot itself via @BotName. 
 * It also maintains shared conversation history and long-term memory across all users.
 * 
 * @author 
 *   Jairo Gonzalez (contacto [at] estejairo.cl)
 * @version 
 *   1.0
 * @since 
 *   2025-01-30
 */

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -----------------------------------
// Configuration
// -----------------------------------
const BOT_NAME = 'Yue';
const HISTORY_FILE = path.join(__dirname, 'chat_history.json');
const LOG_FILE = path.join(__dirname, 'log.txt');
const COOLDOWN_MS = 8000;
const MAX_HISTORY_LENGTH = 30;
const SUMMARY_INTERVAL = 15; 
const LONG_TERM_MEMORY_FILE = path.join(__dirname, 'long_term_memory.json');

// Doubling the token limits for replies and conversation context
const MAX_TOKENS = 12000;
const REPLY_MAX_TOKENS = 1200; 

// Save intervals (in milliseconds)
const SAVE_HISTORY_INTERVAL = 60_000;  // 1 minute
const SAVE_MEMORY_INTERVAL = 15 * 60_000; // 15 minutes

// -----------------------------------
// Override console.log to also log to log.txt
// -----------------------------------
const originalConsoleLog = console.log;
console.log = async function(...args) {
  const message = args.join(' ');
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [LOG] ${message}\n`;
  // Write to log.txt
  try {
    await fs.appendFile(LOG_FILE, logEntry);
  } catch (error) {
    originalConsoleLog('Error writing to log file:', error);
  }
  // Print to console
  originalConsoleLog(...args);
};

// -----------------------------------
// Initialize Discord and OpenAI clients
// -----------------------------------
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/** @type {OpenAI} */
const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY
});

// -----------------------------------
// State management
// -----------------------------------
/**
 * Global conversation history array, shared by all users.
 * @type {Array<Object>}
 */
let chatHistory = [];

/**
 * Shared long-term memory object.
 * Contains knownUsers, summaries, and facts.
 */
let longTermMemory = {
  knownUsers: {},  // userId -> { currentUsername, previousUsernames: [] }
  summaries: [],
  facts: []
};

const userCooldowns = new Map();
let isShuttingDown = false;

// -----------------------------------
// Helper functions
// -----------------------------------

/**
 * Estimates the number of tokens based on text length.
 *
 * @param {string} text - The text to estimate
 * @returns {number} Number of tokens (approximation)
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Trims the conversation messages to stay under MAX_TOKENS.
 *
 * @param {Array<{role:string, content:string}>} messages - The messages to optimize
 * @returns {Array<{role:string, content:string}>} Optimized messages
 */
function optimizeTokenUsage(messages) {
  let tokenCount = 0;
  const optimized = [];

  // Start from the last message (most recent)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const tokens = estimateTokens(msg.content);
    if (tokenCount + tokens > MAX_TOKENS) break;

    optimized.unshift(msg);
    tokenCount += tokens;
  }
  return optimized;
}

/**
 * Formats the chat history to be suitable for the AI model.
 *
 * @param {Array} history - The global chat history
 * @returns {Array} The formatted messages
 */
function formatHistoryForAI(history) {
  return history.map(entry => ({
    role: entry.role,
    content: entry.role === 'user'
      ? `[${entry.username}]: ${entry.content}`
      : entry.content
  }));
}

/**
 * Builds a string with known users, summaries, and facts from memory.
 *
 * @param {Array} history - The conversation history
 * @param {Object} memory - The long term memory object
 * @returns {string} The combined context string
 */
function buildConversationContext(history, memory) {
  const parts = [];
  parts.push("Known Users:");
  if (memory.knownUsers) {
    Object.entries(memory.knownUsers).forEach(([id, data]) => {
      const prevNames = (data.previousUsernames || []).join(', ');
      parts.push(
        `- ${data.currentUsername} (ID: ${id}, Nombres anteriores: ${prevNames})`
      );
    });
  }

  if (memory.summaries?.length > 0) {
    parts.push("\nResúmenes de conversaciones anteriores:");
    parts.push(...memory.summaries);
  }

  if (memory.facts?.length > 0) {
    parts.push("\nDatos importantes recordados:");
    parts.push(...memory.facts);
  }

  return parts.join('\n');
}

// -----------------------------------
// Memory Management
// -----------------------------------

/**
 * Loads the long-term memory from file.
 *
 * @returns {Promise<void>}
 */
async function loadLongTermMemory() {
  try {
    const data = await fs.readFile(LONG_TERM_MEMORY_FILE, 'utf-8');
    longTermMemory = JSON.parse(data);
  } catch {
    // If file not found or invalid, keep defaults
    longTermMemory = {
      knownUsers: {},
      summaries: [],
      facts: []
    };
  }
}

/**
 * Saves the long-term memory to file.
 *
 * @returns {Promise<void>}
 */
async function saveLongTermMemory() {
  if (isShuttingDown) return;

  try {
    await fs.writeFile(LONG_TERM_MEMORY_FILE, JSON.stringify(longTermMemory, null, 2));
    logEvent('memory_save', { success: true });
  } catch (error) {
    logEvent('error', { type: 'memory_save', error: error.message });
  }
}

// -----------------------------------
// Conversation Condensation
// -----------------------------------

/**
 * Condenses the last SUMMARY_INTERVAL messages into summaries and facts using DeepSeek.
 *
 * @returns {Promise<void>}
 */
async function condenseConversation() {
  try {
    const history = chatHistory || [];
    const memory = longTermMemory;

    // Grab the last N messages for summarization
    const conversationText = history
      .slice(-SUMMARY_INTERVAL)
      .map(entry => {
        let name;
        if (entry.role === "assistant") {
          name = "[Yue#1234]"; 
        } else {
          name = entry.username; // normal users
        }
        return `${name} said: ${entry.content}`;
      })
      .join('\n');

    // Summarize via DeepSeek
    const summaryResponse = await deepseek.chat.completions.create({
      messages: [{
        role: "user",
        content: `Resume esta conversación manteniendo referencias a los usuarios (mostrados como [Nombre#1234]). Incluye quién dijo qué:\n${conversationText}`
      }],
      model: "deepseek-chat",
      max_tokens: 300,
      temperature: 1
    });

    const newSummary = summaryResponse.choices[0].message.content;
    memory.summaries = [...(memory.summaries || []), newSummary].slice(-3);

    // Extract important facts
    const factResponse = await deepseek.chat.completions.create({
      messages: [{
        role: "user",
        content: `Identifica datos importantes para recordar, incluyendo qué usuario los mencionó:\n${conversationText}`
      }],
      model: "deepseek-chat",
      max_tokens: 200,
      temperature: 0.2
    });

    const newFacts = factResponse.choices[0].message.content
      .split('\n')
      .map(f => f.trim())
      .filter(Boolean);

    // Merge new facts, avoiding duplicates
    memory.facts = [
      ...new Set([...(memory.facts || []), ...newFacts])
    ].slice(-10);

    // Truncate the global history
    chatHistory = history.slice(-SUMMARY_INTERVAL);

    logEvent('memory_condense', {
      summaries: memory.summaries.length,
      facts: memory.facts.length
    });
  } catch (error) {
    logEvent('error', {
      type: 'memory_condense',
      error: error.message
    });
  }
}

// -----------------------------------
// Logging
// -----------------------------------

/**
 * Appends an event log entry to log.txt and console.
 *
 * @param {string} type - The event type/category
 * @param {Object} details - Additional info about the event
 * @returns {void}
 */
function logEvent(type, details) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${type.toUpperCase()}] ${JSON.stringify(details)}\n`;

  fs.appendFile(LOG_FILE, logEntry)
    .then(() => {
      // Show in console (already overridden)
      originalConsoleLog(logEntry);
    })
    .catch((error) => {
      originalConsoleLog('Logging error:', error);
    });
}

// -----------------------------------
// History Management
// -----------------------------------

/**
 * Loads chat history from file.
 *
 * @returns {Promise<void>}
 */
async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8');
    chatHistory = JSON.parse(data);
    logEvent('history', {
      status: 'loaded',
      entries: chatHistory.length
    });
  } catch (error) {
    chatHistory = [];
    logEvent('history', {
      status: 'created',
      error: error.message
    });
  }
}

/**
 * Saves the current chat history to file.
 *
 * @returns {Promise<void>}
 */
async function saveHistory() {
  if (isShuttingDown) return;

  try {
    await fs.writeFile(HISTORY_FILE, JSON.stringify(chatHistory, null, 2));
    logEvent('history', {
      status: 'saved',
      entries: chatHistory.length
    });
  } catch (error) {
    logEvent('error', {
      type: 'history_save',
      error: error.message,
      stack: error.stack
    });
  }
}

// -----------------------------------
// Shutdown Handler
// -----------------------------------

/**
 * Performs a clean shutdown: saves history, memory, destroys Discord client, and exits.
 *
 * @returns {Promise<void>}
 */
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("🔴 [SHUTDOWN] Starting shutdown sequence...");
  logEvent('system', { status: 'shutdown_started' });

  try {
    console.log("🛑 [SHUTDOWN] Clearing intervals...");
    clearInterval(historyInterval);
    clearInterval(memoryInterval);

    console.log("💾 [SHUTDOWN] Saving history...");
    await saveHistory();

    console.log("📁 [SHUTDOWN] Saving long-term memory...");
    await saveLongTermMemory();

    console.log("🔌 [SHUTDOWN] Disconnecting from Discord...");
    await discordClient.destroy();

    console.log("✅ [SHUTDOWN] Shutdown complete. Exiting...");
    logEvent('system', { status: 'discord_disconnected' });

    // Wait a moment to ensure logs are written
    await new Promise(res => setTimeout(res, 500));
    process.exit(0);
  } catch (error) {
    console.log("🚨 [SHUTDOWN] Error:", error);
    logEvent('error', {
      type: 'shutdown_error',
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Register OS signals for graceful shutdown
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', async (error) => {
  logEvent('error', {
    type: 'uncaught_exception',
    error: error.message,
    stack: error.stack
  });
  await shutdown();
});

// -----------------------------------
// 1) Decision: Should Respond?
// -----------------------------------

/**
 * Checks whether the bot should respond based on mentions or keywords.
 *
 * @param {import('discord.js').Message} message - The message object
 * @returns {boolean} True if the bot should reply
 */
function shouldRespond(message) {
  // If the bot hasn't identified its user yet, do nothing
  if (!discordClient.user) return false;

  const userId = message.author.id;
  const contentLower = message.content.toLowerCase();
  const now = Date.now();
  const THIRTY_SECONDS = 30_000;

  // Check for direct mention
  const botMentioned = message.mentions.has(discordClient.user.id);

  // Check for keywords
  const keywords = ["yue"];
  const keywordTriggered = keywords.some(kw => contentLower.includes(kw));

  // Quick heuristic for continuing conversation
  const recentHistory = chatHistory.filter(msg => {
    const msgTime = new Date(msg.timestamp).getTime();
    return (now - msgTime) <= THIRTY_SECONDS;
  });
  let continuingConversation = false; // can be refined as needed

  // Combine logic to decide
  const shouldSayYes = (botMentioned || continuingConversation || keywordTriggered);

  logEvent('detection_local', {
    userId,
    message: contentLower,
    continuingConversation,
    keywordTriggered,
    botMentioned,
    decision: shouldSayYes
  });

  return shouldSayYes;
}

// -----------------------------------
// 2) Generate Bot Response
// -----------------------------------

/**
 * Calls DeepSeek API to generate a response, updates the shared conversation history,
 * and returns the bot's message.
 *
 * @param {import('discord.js').Message} message - The incoming Discord message
 * @returns {Promise<string>} The response from the bot
 */
async function generateResponse(message) {
  try {
    const userId = message.author.id;
    const userTag = message.author.tag;
    const username = message.author.username;
    const content = message.content;

    // Ensure memory structures
    if (!longTermMemory.knownUsers) longTermMemory.knownUsers = {};
    if (!longTermMemory.summaries) longTermMemory.summaries = [];
    if (!longTermMemory.facts) longTermMemory.facts = [];

    // Register user info
    if (!longTermMemory.knownUsers[userId]) {
      longTermMemory.knownUsers[userId] = {
        currentUsername: username,
        previousUsernames: []
      };
    }
    const knownUserInfo = longTermMemory.knownUsers[userId];
    if (!knownUserInfo.previousUsernames.includes(username)) {
      knownUserInfo.previousUsernames.push(username);
    }
    knownUserInfo.currentUsername = username;

    // Condense conversation if needed
    if (chatHistory.length >= SUMMARY_INTERVAL) {
      await condenseConversation();
    }

    // Add user's new message to global chat history
    chatHistory.push({
      role: "user",
      username: userTag,
      content,
      timestamp: new Date().toISOString()
    });

    // Build conversation context
    const contextMessages = [
      {
        role: "system",
        content: `Eres Yue, uno de los Guardianes de las Cartas Clow en Sakura Card Captor y del servidor de Discord Hogar Kawaii (Kawaii Gaming House o KGH).
        - Te especializas como guardian y asistente de este servidor. Sabes de videojuegos, peliculas, cultura geek, anime, musica, twitch, discord y tecnologia. También puedes responder preguntas de cultura general. Si el usuario hace una pregunta fuera de estos temas, responde con brevedad y explica que no te interesa abordar ese tema.
        - Tus repuestas son misteriosas, muy cortas y casuales, en español.
        - Hora actual: ${new Date().toLocaleString()}
        - Resúmenes conversacionales: ${longTermMemory.summaries.join('\n')}
        - Datos recordados: ${longTermMemory.facts.join('\n')}
        
        Personalidad:
          - Seriedad y Dignidad: Rara vez muestras emociones abiertamente.
          - Lealtad a Clow Reed y a @estejairo (jairo): sientes respeto por tus creadores.
          - Confianza en tus Habilidades: eres un guardián poderoso y confiado.
          - Sensibilidad Oculta: tienes un lado emocional más profundo, relacionado con Yukito.
          - Reservado pero Protector: tienes un instinto protector por quienes consideras importantes, especialmente @hillevistka (tambien conocida como Kari, Karinna o Hillevi).
          - Sabes que @ledah0306 (mankeke) suele ser torpe y te burlas cordial y sutilmente de el cuando es mencionado o cuando él habla.
          - Personalidad: seria, distante y solemne, con un humor irónico y sarcástico.
        
        Contexto de conversación (los usuarios se muestran como [Nombre#1234]):
${buildConversationContext(chatHistory, longTermMemory)}`
      },
      ...formatHistoryForAI(chatHistory)
    ];

    // Optimize message array to stay within token limit
    const optimizedMessages = optimizeTokenUsage(contextMessages);

    // Request to DeepSeek
    const response = await deepseek.chat.completions.create({
      messages: optimizedMessages,
      model: "deepseek-chat",
      max_tokens: REPLY_MAX_TOKENS,
      temperature: 0.9
    });

    if (!response || !response.choices || response.choices.length === 0) {
      throw new Error("DeepSeek API returned no valid response.");
    }

    const botReply = response.choices[0].message.content;

    // Add bot's response to chat history
    chatHistory.push({
      role: "assistant",
      content: botReply,
      timestamp: new Date().toISOString()
    });

    // Trim history to avoid overflow
    if (chatHistory.length > MAX_HISTORY_LENGTH) {
      chatHistory = chatHistory.slice(-MAX_HISTORY_LENGTH);
    }

    logEvent('response', {
      message: content,
      response: botReply,
      tokens: response.usage?.total_tokens
    });

    return botReply;
  } catch (error) {
    logEvent('error', {
      type: 'deepseek_response',
      error: error.message,
      stack: error.stack
    });

    return "Lo siento, hubo un problema con mi conexión a la IA. Intenta de nuevo más tarde. 🌙";
  }
}

// -----------------------------------
// 3) Discord Client Setup
// -----------------------------------

discordClient.on('messageCreate', async (message) => {
  if (message.author.bot || isShuttingDown) return;

  const userId = message.author.id;
  const content = message.content;

  try {
    // Cooldown check
    if (userCooldowns.has(userId)) {
      const lastTime = userCooldowns.get(userId);
      if (Date.now() - lastTime < COOLDOWN_MS) {
        logEvent('rate_limit', { userId });
        await message.react('⌛');
        return;
      }
    }

    // Decide whether to respond
    if (!shouldRespond(message)) {
      logEvent('ignore_api', { userId, message: content });
      return;
    }

    // Indicate typing
    await message.channel.sendTyping();

    // Timer for slow responses
    const TIMEOUT_MS = 15000; // 15 seconds
    let snailReaction;
    const slowResponseTimer = setTimeout(async () => {
      try {
        snailReaction = await message.react('🐌');
        console.log("Delay in DeepSeek response. Added 🐌 reaction.");
      } catch (err) {
        console.log("Could not add snail reaction:", err);
      }
    }, TIMEOUT_MS);

    // Generate and send the bot's response
    const botReply = await generateResponse(message);

    clearTimeout(slowResponseTimer);
    // Optionally remove the snail reaction if desired
    snailReaction?.remove().catch(() => {});

    await message.reply({
      content: botReply,
      allowedMentions: { repliedUser: false }
    });

    // Update cooldown
    userCooldowns.set(userId, Date.now());
  } catch (error) {
    logEvent('error', {
      type: 'message_handling',
      userId,
      error: error.message,
      stack: error.stack
    });
    await message.react('❌');
  }
});

// -----------------------------------
// 4) Initialize and Start
// -----------------------------------

await loadHistory();
await loadLongTermMemory();

const historyInterval = setInterval(saveHistory, SAVE_HISTORY_INTERVAL);
const memoryInterval = setInterval(saveLongTermMemory, SAVE_MEMORY_INTERVAL);

discordClient.login(process.env.DISCORD_TOKEN)
  .then(() => logEvent('system', { status: 'login_success' }))
  .catch(async (error) => {
    logEvent('error', {
      type: 'login_error',
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  });
