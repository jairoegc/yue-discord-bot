/**
 * @fileoverview Yue Discord Bot
 * 
 * This file implements a single-conversation Discord bot named Yue.
 * Yue responds to messages that mention certain keywords or the bot itself via @BotName.
 * It maintains a short conversation history (the last N messages) to support multi-round conversations.
 * 
 * Error responses from DeepSeek are logged using their respective error codes.
 * 
 * @author 
 *   Jairo Gonzalez (contacto [at] estejairo.cl)
 * @version 
 *   2.1
 * @since 
 *   2025-01-30
 */

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -----------------------------------
// Configuration
// -----------------------------------
const BOT_NAME = 'Yue';
const HISTORY_FILE = path.join(__dirname, 'chat_history.json');
const LOG_FILE = path.join(__dirname, 'log.txt');
const COOLDOWN_MS = 8000;
const MAX_HISTORY_LENGTH = 30; // maximum number of messages (rounds) to keep
const REPLY_MAX_TOKENS = 1200; 

// Save interval (in milliseconds)
const SAVE_HISTORY_INTERVAL = 60_000;  // 1 minute

// -----------------------------------
// Error codes mapping (from DeepSeek API docs)
// -----------------------------------
const ERROR_CODE_MAP = {
  400: 'Invalid Format',
  401: 'Authentication Fails',
  402: 'Insufficient Balance',
  422: 'Invalid Parameters',
  429: 'Rate Limit Reached',
  500: 'Server Error',
  503: 'Server Overloaded'
};

// -----------------------------------
// Override console.log to also log to log.txt
// -----------------------------------
const originalConsoleLog = console.log;
console.log = async function(...args) {
  const message = args.join(' ');
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [LOG] ${message}\n`;
  try {
    await fs.appendFile(LOG_FILE, logEntry);
  } catch (error) {
    originalConsoleLog('Error writing to log file:', error);
  }
  originalConsoleLog(...args);
};

// -----------------------------------
// Initialize Discord and DeepSeek clients
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
// Global State
// -----------------------------------
/**
 * Global conversation history array, shared by all users.
 * Each entry: { role, username (if user), content, timestamp }
 * @type {Array<Object>}
 */
let chatHistory = [];

const userCooldowns = new Map();
let isShuttingDown = false;

// -----------------------------------
// Helper Functions
// -----------------------------------

/**
 * Estimates number of tokens based on text length.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Optimizes an array of messages to stay under a maximum token limit.
 * It starts from the most recent messages.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Array<{role:string, content:string}>}
 */
function optimizeTokenUsage(messages) {
  let tokenCount = 0;
  const optimized = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const tokens = estimateTokens(msg.content);
    if (tokenCount + tokens > MAX_HISTORY_LENGTH * 50) break; // adjust as needed
    optimized.unshift(msg);
    tokenCount += tokens;
  }
  return optimized;
}

/**
 * Formats the chat history for the AI model.
 * User messages include the username tag.
 * @param {Array} history
 * @returns {Array}
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
 * Logs an event with error code details if available.
 * @param {string} type - The event type/category.
 * @param {Object} details - Additional event details.
 */
function logEvent(type, details) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${type.toUpperCase()}] ${JSON.stringify(details)}\n`;
  fs.appendFile(LOG_FILE, logEntry)
    .then(() => originalConsoleLog(logEntry))
    .catch((error) => originalConsoleLog('Logging error:', error));
}

/**
 * Helper to log errors from DeepSeek API calls.
 * @param {Error} error
 * @param {string} context - Context label (e.g. "deepseek_response")
 */
function logDeepSeekError(error, context) {
  const code = error?.response?.status;
  const description = code && ERROR_CODE_MAP[code] ? ERROR_CODE_MAP[code] : 'Unknown error';
  logEvent('error', {
    type: context,
    error: error.message,
    code: code || 'N/A',
    description,
    stack: error.stack
  });
}

// -----------------------------------
// History Management Functions
// -----------------------------------

/**
 * Loads chat history from file.
 */
async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8');
    chatHistory = JSON.parse(data);
    logEvent('history', { status: 'loaded', entries: chatHistory.length });
  } catch (error) {
    chatHistory = [];
    logEvent('history', { status: 'created', error: error.message });
  }
}

/**
 * Saves chat history to file.
 */
async function saveHistory() {
  if (isShuttingDown) return;
  try {
    await fs.writeFile(HISTORY_FILE, JSON.stringify(chatHistory, null, 2));
    logEvent('history', { status: 'saved', entries: chatHistory.length });
  } catch (error) {
    logDeepSeekError(error, 'history_save');
  }
}

// -----------------------------------
// Shutdown Handler
// -----------------------------------

/**
 * Performs a clean shutdown: saves history, disconnects Discord.
 */
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log("🔴 [SHUTDOWN] Starting shutdown sequence...");
  logEvent('system', { status: 'shutdown_started' });
  try {
    console.log("🛑 [SHUTDOWN] Clearing intervals...");
    clearInterval(historyInterval);
    console.log("💾 [SHUTDOWN] Saving history...");
    await saveHistory();
    console.log("🔌 [SHUTDOWN] Disconnecting from Discord...");
    await discordClient.destroy();
    console.log("✅ [SHUTDOWN] Shutdown complete. Exiting...");
    logEvent('system', { status: 'discord_disconnected' });
    await new Promise(res => setTimeout(res, 500));
    process.exit(0);
  } catch (error) {
    console.log("🚨 [SHUTDOWN] Error:", error);
    logDeepSeekError(error, 'shutdown_error');
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', async (error) => {
  logDeepSeekError(error, 'uncaught_exception');
  await shutdown();
});


// -----------------------------------
// Palworld Server Management
// -----------------------------------
const SERVER_EXECUTABLE = "PalServer-Win64-Shipping-Cmd.exe";
const STEAM_URL = "steam://rungameid/2394010";


async function startServer() {
  try {
    const isRunning = await checkServerRunning();
    if (isRunning) {
      return "⚠️ El servidor ya está en ejecución";
    }

    return new Promise((resolve, reject) => {
      exec(`start "" "${STEAM_URL}"`, async (error) => {
        if (error) {
          reject(`❌ Error al iniciar: ${error.message}`);
          return;
        }

        // Wait and verify startup
        let attempts = 0;
        const checkInterval = setInterval(async () => {
          attempts++;
          const isRunningNow = await checkServerRunning();
          
          if (isRunningNow) {
            clearInterval(checkInterval);
            resolve("✅ Servidor iniciado correctamente");
          } else if (attempts >= 6) { // 30 seconds total (6 attempts * 5 seconds)
            clearInterval(checkInterval);
            reject("⚠️ El servidor no se inició después de 30 segundos");
          }
        }, 5000);
      });
    });
  } catch (error) {
    throw error;
  }
}

async function closeServer() {
  try {
    const isRunning = await checkServerRunning();
    if (!isRunning) {
      return "ℹ️ El servidor no estaba en ejecución";
    }

    return new Promise((resolve, reject) => {
      exec(`taskkill /F /IM "${SERVER_EXECUTABLE}"`, (error, stdout) => {
        if (error) {
          if (error.message.includes('no se encuentra')) {
            resolve("ℹ️ El servidor ya estaba cerrado");
          } else {
            reject(`❌ Error al cerrar: ${error.message}`);
          }
        } else {
          resolve("✅ Servidor cerrado correctamente");
        }
      });
    });
  } catch (error) {
    throw error;
  }
}
async function checkServerRunning() {
  return new Promise((resolve) => {
    exec(`tasklist /FI "IMAGENAME eq ${SERVER_EXECUTABLE}"`, (error, stdout) => {
      resolve(stdout.toLowerCase().includes(SERVER_EXECUTABLE.toLowerCase()));
    });
  });
}

async function restartServer() {
  try {
    const isRunning = await checkServerRunning();
    
    // If not running, just start it
    if (!isRunning) {
      return await startServer();
    }

    // If running, perform proper restart
    const closeResult = await closeServer();
    if (!closeResult.startsWith("✅")) {
      throw new Error(`Error durante el cierre: ${closeResult}`);
    }

    // Wait 5 seconds before starting again
    await new Promise(res => setTimeout(res, 5000));
    
    const startResult = await startServer();
    return `🔄 Reinicio completado:\n- Cierre: ${closeResult}\n- Inicio: ${startResult}`;
  } catch (error) {
    throw error;
  }
}

// -----------------------------------
// Function Calling Configuration
// -----------------------------------
const tools = [
  {
    type: "function",
    function: {
      name: "start_palworld_server",
      description: "Inicia el servidor Palworld mediante Steam. Verifica si ya está corriendo primero.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "close_palworld_server",
      description: "Cierra el servidor de Palworld terminando su consola",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "restart_palworld_server",
      description: "Reinicia el servidor cerrando y volviendo a abrir",
      parameters: { type: "object", properties: {} }
    }
  }
];

// -----------------------------------
// 1) Should Respond? (Message filtering)
// -----------------------------------

/**
 * Determines if the bot should respond to a message.
 * Now it only checks for direct mentions or keyword presence.
 * @param {import('discord.js').Message} message
 * @returns {boolean}
 */
function shouldRespond(message) {
  if (!discordClient.user) return false;
  const contentLower = message.content.toLowerCase();
  const botMentioned = message.mentions.has(discordClient.user.id);
  const keywords = ["yue","mankeke","ledah0306", "yukito", "sakura","kerberos"];
  const keywordTriggered = keywords.some(kw => contentLower.includes(kw));
  const decision = botMentioned || keywordTriggered;
  logEvent('detection_local', {
    userId: message.author.id,
    message: contentLower,
    botMentioned,
    keywordTriggered,
    decision
  });
  return decision;
}

// -----------------------------------
// 2) Generate Bot Response via DeepSeek API
// -----------------------------------

/**
 * Generates a response by calling the DeepSeek API.
 * It appends the new message to the chat history and builds a multi-round context
 * based solely on the recent conversation history.
 * @param {import('discord.js').Message} message
 * @returns {Promise<string>}
 */
async function generateResponse(message) {
  try {
    const userTag = message.author.tag;
    const username = message.author.username;
    const content = message.content;

    // Append the user's new message to the conversation history
    chatHistory.push({
      role: "user",
      username: userTag,
      content,
      timestamp: new Date().toISOString()
    });

    // Build a system prompt with a static personality and current time
    const systemPrompt = {
      role: "system",
      content: `Eres Yue, uno de los Guardianes de las Cartas Clow en Sakura Card Captor y del servidor de Discord Hogar Kawaii (Kawaii Gaming House o KGH).
        - Te especializas como guardian y asistente de este servidor. Sabes de videojuegos, peliculas, cultura geek, anime, musica, twitch, discord y tecnologia. También puedes responder preguntas de cultura general. Si el usuario hace una pregunta fuera de estos temas, responde con brevedad y explica que no te interesa abordar ese tema.
        - Tus repuestas en español.
        - Hora actual: ${new Date().toLocaleString()}
        Personalidad:
          - Lealtad a Clow Reed y a @estejairo (jairo): sientes respeto por tus creadores.
          - Reservado pero Protector: tienes un instinto protector por quienes consideras importantes, especialmente @hillevistka (tambien conocida como Kari, Karinna o Hillevi), como Yude del anime protege a Sakura.
          - Sabes que @ledah0306 (mankeke) suele ser torpe y despistado. Te burlas cordial y sutilmente de él cuando es mencionado o cuando él habla.
          - Personalidad: Serio, reservado y estoico. Frío y distante. Orgulloso y fuerte. Reflexivo y melancólico. Humor irónico y sarcástico.
        También puedes gestionar el servidor de Palworld. Usa estas funciones cuando los miembros lo soliciten explicitamente. Siempre verifica primero si ya está ejecutándose. Notifica claramente el resultado de cada acción:
        - start_palworld_server: Para iniciar el servidor
        - close_palworld_server: Para cerrar el servidor
        - restart_palworld_server: Para reiniciar el servidor`
    };

    // Build the conversation context using only the recent history
    const contextMessages = [
      systemPrompt,
      ...formatHistoryForAI(chatHistory)
    ];

    // Optimize the messages to ensure they are within token limits
    const optimizedMessages = optimizeTokenUsage(contextMessages);

    // Trim history to the last MAX_HISTORY_LENGTH messages only
    if (chatHistory.length > MAX_HISTORY_LENGTH) {
      chatHistory = chatHistory.slice(-MAX_HISTORY_LENGTH);
    }

    const response = await deepseek.chat.completions.create({
      messages: optimizedMessages,
      model: "deepseek-chat",
      max_tokens: REPLY_MAX_TOKENS,
      temperature: 1.3,
      tools: tools
    });

    if (!response.choices[0].message) throw new Error("No valid response");

    // Handle function calling
    const toolCall = response.choices[0].message.tool_calls?.[0];
    if (toolCall) {
      let result;
      switch (toolCall.function.name) {
        case 'start_palworld_server':
          const isRunning = await checkServerRunning();
          if (isRunning) {
            result = "⚠️ El servidor ya está en ejecución";
          } else {
            result = await startServer();
          }
          break;
        case 'close_palworld_server':
          result = await closeServer();
          break;
        case 'restart_palworld_server':
          try {
            result = await restartServer();
          } catch (error) {
            result = `❌ Error en reinicio: ${error.message}`;
          }
          break;
        default:
          result = 'Función desconocida';
      }

      // Append function result to history
      chatHistory.push({
        role: "assistant",
        content: `Ejecutado ${toolCall.function.name}: ${result}`,
        timestamp: new Date().toISOString()
      });

      return `✅ Comando ejecutado: ${result}`;
    }

    // Handle normal response
    const botReply = response.choices[0].message.content;
    chatHistory.push({
      role: "assistant",
      content: botReply,
      timestamp: new Date().toISOString()
    });

    logEvent('response', {
      message: content,
      response: botReply,
      tokens: response.usage?.total_tokens
    });

    return botReply;
  } catch (error) {
    logDeepSeekError(error, 'deepseek_response');
    return "Lo siento, hubo un problema con mi conexión a la IA. Intenta de nuevo más tarde. 🌙";
  }
}

// -----------------------------------
// 3) Discord Client Message Handling
// -----------------------------------

discordClient.on('messageCreate', async (message) => {
  if (message.author.bot || isShuttingDown) return;

  const userId = message.author.id;
  const content = message.content;

  try {
    // Cooldown check per user
    if (userCooldowns.has(userId)) {
      const lastTime = userCooldowns.get(userId);
      if (Date.now() - lastTime < COOLDOWN_MS) {
        logEvent('rate_limit', { userId });
        await message.react('⌛');
        return;
      }
    }

    // Check if the bot should respond (only direct mention or keyword trigger)
    if (!shouldRespond(message)) {
      logEvent('ignore_api', { userId, message: content });
      return;
    }

    // Indicate typing
    await message.channel.sendTyping();

    // Set a timer to react with a snail if the response takes too long
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

    // Generate the bot's response using DeepSeek
    const botReply = await generateResponse(message);

    clearTimeout(slowResponseTimer);
    snailReaction?.remove().catch(() => {});

    await message.reply({
      content: botReply,
      allowedMentions: { repliedUser: false }
    });

    // Update cooldown for the user
    userCooldowns.set(userId, Date.now());
  } catch (error) {
    logDeepSeekError(error, 'message_handling');
    await message.react('❌');
  }
});

// -----------------------------------
// 4) Initialize and Start
// -----------------------------------

await loadHistory();

const historyInterval = setInterval(saveHistory, SAVE_HISTORY_INTERVAL);

discordClient.login(process.env.DISCORD_TOKEN)
  .then(() => logEvent('system', { status: 'login_success' }))
  .catch(async (error) => {
    logDeepSeekError(error, 'login_error');
    process.exit(1);
  });
