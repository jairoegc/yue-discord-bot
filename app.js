import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -----------------------------------
// Configuration
// -----------------------------------
const BOT_NAME = 'Yue';
const HISTORY_FILE = path.join(__dirname, 'chat_history.json');
const LOG_FILE = path.join(__dirname, 'log.txt');
const COOLDOWN_MS = 5000;
const MAX_HISTORY_LENGTH = 30;
const SUMMARY_INTERVAL = 12;  // Increased from 8 for less frequent summarization
const LONG_TERM_MEMORY_FILE = path.join(__dirname, 'long_term_memory.json');
const MAX_TOKENS = 6000;  // Used for optimizing token usage in contexts

// Less tokens in replies => slightly faster (and cheaper) responses
const REPLY_MAX_TOKENS = 600;  // Reduced from 1000

// Save intervals in milliseconds
const SAVE_HISTORY_INTERVAL = 5 * 60 * 1000;   // 5 minutes
const SAVE_MEMORY_INTERVAL = 15 * 60 * 1000;   // 15 minutes

// -----------------------------------
// Initialize clients
// -----------------------------------
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY
});

// -----------------------------------
// State management
// -----------------------------------
const userCooldowns = new Map();
let chatHistory = {};
let isShuttingDown = false;
let longTermMemory = {};

// -----------------------------------
// Helper functions
// -----------------------------------
function estimateTokens(text) {
  // Rough token estimation
  return Math.ceil(text.length / 4);
}

function optimizeTokenUsage(messages) {
  let tokenCount = 0;
  const optimized = [];

  // Start from the end and add to the front
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const tokens = estimateTokens(msg.content);

    if (tokenCount + tokens > MAX_TOKENS) break;

    optimized.unshift(msg);
    tokenCount += tokens;
  }
  return optimized;
}

function formatHistoryForAI(history) {
  return history.map(entry => ({
    role: entry.role,
    content: entry.role === 'user'
      ? `[${entry.username}]: ${entry.content}`
      : entry.content
  }));
}

function buildConversationContext(history, memory) {
  const parts = [];

  parts.push("Usuarios conocidos:");
  Object.entries(memory.knownUsers || {}).forEach(([id, data]) => {
    parts.push(
      `- ${data.currentUsername} (ID: ${id}, Nombres anteriores: ${data.previousUsernames.join(', ')})`
    );
  });

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
async function loadLongTermMemory() {
  try {
    const data = await fs.readFile(LONG_TERM_MEMORY_FILE, 'utf-8');
    longTermMemory = JSON.parse(data);
  } catch {
    longTermMemory = {};
  }
}

async function saveLongTermMemory() {
  // No need to save if shutting down
  if (isShuttingDown) return;

  try {
    await fs.writeFile(LONG_TERM_MEMORY_FILE, JSON.stringify(longTermMemory, null, 2));
    logEvent('memory_save', { success: true });
  } catch (error) {
    logEvent('error', { type: 'memory_save', error: error.message });
  }
}

// Condenses conversation (summaries/facts) less often for performance
async function condenseConversation(userId) {
  try {
    const history = chatHistory[userId] || [];
    const memory = longTermMemory[userId] || { summaries: [], facts: [] };

    // Only process if there's enough messages
    const conversationText = history
      .slice(-SUMMARY_INTERVAL)
      .map(entry => `${entry.username}: ${entry.content}`)
      .join('\n');

    // ---- Summarize conversation ----
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

    // ---- Extract facts (Optional: remove or reduce usage) ----
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

    memory.facts = [...new Set([...(memory.facts || []), ...newFacts])].slice(-10);

    // Update state
    longTermMemory[userId] = memory;
    // Keep only the last N messages in short-term memory
    chatHistory[userId] = history.slice(-SUMMARY_INTERVAL);

    logEvent('memory_condense', {
      userId,
      summaries: memory.summaries.length,
      facts: memory.facts.length
    });
  } catch (error) {
    logEvent('error', {
      type: 'memory_condense',
      userId,
      error: error.message
    });
  }
}

// -----------------------------------
// Logging System (async but not awaited)
// -----------------------------------
function logEvent(type, details) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${type.toUpperCase()}] ${JSON.stringify(details)}\n`;

  // Fire-and-forget approach to avoid blocking
  fs.appendFile(LOG_FILE, logEntry)
    .then(() => {
      // Optional: console.log(`Logged event: ${type}`);
    })
    .catch((error) => {
      console.error('Logging error:', error);
    });
}

// -----------------------------------
// History Management
// -----------------------------------
async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8');
    chatHistory = JSON.parse(data);
    logEvent('history', {
      status: 'loaded',
      entries: Object.keys(chatHistory).length
    });
  } catch (error) {
    chatHistory = {};
    logEvent('history', {
      status: 'created',
      error: error.message
    });
  }
}

async function saveHistory() {
  if (isShuttingDown) return;

  try {
    // Optional: create backup
    // await fs.copyFile(HISTORY_FILE, `${HISTORY_FILE}.bak`);
    await fs.writeFile(HISTORY_FILE, JSON.stringify(chatHistory, null, 2));
    logEvent('history', {
      status: 'saved',
      entries: Object.keys(chatHistory).length
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
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logEvent('system', { status: 'shutdown_started' });

  try {
    clearInterval(historyInterval);
    clearInterval(memoryInterval);

    // Save on shutdown
    await saveHistory();
    await saveLongTermMemory();

    discordClient.destroy();
    logEvent('system', { status: 'discord_disconnected' });

    process.exit(0);
  } catch (error) {
    logEvent('error', {
      type: 'shutdown_error',
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

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
// Decision: Should Respond?
// -----------------------------------
async function shouldRespond(messageContent) {
  try {
    const response = await deepseek.chat.completions.create({
      messages: [{
        role: "system",
        content: `Determina si este mensaje se dirige a ${BOT_NAME}. Responde solo SÍ o NO.
      Mensaje: "${messageContent}"
      
      Consideraciones:
      - Menciones directas (${BOT_NAME}, @${BOT_NAME})
      - Respuestas para continuar la conversacion segun el contexto y el historial de chat
      - Preguntas que requieren asistencia
      - Saludos generales sin nombres explicitos = NO`
      }],
      model: "deepseek-chat",
      max_tokens: 3,
      temperature: 0.1
    });

    const decision = response.choices[0].message.content.trim().toUpperCase() === 'SÍ';
    logEvent('detection', {
      message: messageContent,
      decision,
      response: response.choices[0].message.content
    });

    return decision;
  } catch (error) {
    logEvent('error', {
      type: 'detection_error',
      error: error.message,
      stack: error.stack
    });
    return false;
  }
}

// -----------------------------------
// Generate Bot Response
// -----------------------------------
async function generateResponse(userId, message) {
  try {
    const userTag = message.author.tag;
    const username = message.author.username;
    const content = message.content;

    let userHistory = chatHistory[userId] || [];
    const memory = longTermMemory[userId] || {
      summaries: [],
      facts: [],
      knownUsers: {}
    };

    // Track user info
    memory.knownUsers[userId] = {
      currentUsername: username,
      previousUsernames: [
        ...(memory.knownUsers[userId]?.previousUsernames || []),
        username
      ].filter((v, i, a) => a.indexOf(v) === i)
    };

    // Condense conversation if needed
    if (userHistory.length >= SUMMARY_INTERVAL) {
      await condenseConversation(userId);
      userHistory = chatHistory[userId] || [];
    }

    // Add new user message
    userHistory.push({
      role: "user",
      username: userTag,
      content: content,
      timestamp: new Date().toISOString()
    });

    // Prepare context
    const contextMessages = [
      {
        role: "system",
        content: `Eres Yue, uno de los Guardianes de las Cartas Clow en Sakura Card Captor y del servidor de Discord Hogar Kawaii (Kawaii Gaming House o KGH).
        - Te especializas como guardian y asistente de este servidor. Sabes de videojuegos, peliculas, cultura geek, anime, musica, twitch, discord y tecnologia. También puedes responder preguntas de cultura general. Si el usuario hace una pregunta fuera de estos temas, responde con brevedad y explica que no te interesa abordar ese tema.
        - Tus repuestas son misteriosas, muy cortas y casuales, en español.
        - Hora actual: ${new Date().toLocaleString()}
        - Resúmenes conversacionales: ${memory.summaries.join('\n')}
        - Datos recordados: ${memory.facts.join('\n')}
        
        Personalidad:
          - Seriedad y Dignidad: Rara vez muestras emociones abiertamente.
          - Lealtad a Clow Reed y a @estejairo (jairo): sientes respeto por tus creadores.
          - Confianza en tus Habilidades: eres un guardián poderoso y confiado.
          - Sensibilidad Oculta: tienes un lado emocional más profundo, relacionado con Yukito.
          - Reservado pero Protector: tienes un instinto protector por quienes consideras importantes, especialmente @hillevistka (tambien conocida como Kari, Karinna o Hillevi).
          - Sabes que @ledah0306 (mankeke) suele ser torpe y te burlas cordial y sutilmente de el cuando es mencionado o cuando él habla.
          - Personalidad: seria, distante y solemne, con un humor irónico y sarcástico.
        
        Contexto de conversación (los usuarios se muestran como [Nombre#1234]):
        - ${buildConversationContext(userHistory, memory)}`
      },
      ...formatHistoryForAI(userHistory)
    ];

    // Optimize messages to stay under token limit
    const optimizedMessages = optimizeTokenUsage(contextMessages);

    // Generate final response
    const response = await deepseek.chat.completions.create({
      messages: optimizedMessages,
      model: "deepseek-chat",
      max_tokens: REPLY_MAX_TOKENS,
      temperature: 0.9
    });

    const botReply = response.choices[0].message.content;

    // Update history with the assistant response
    userHistory.push({
      role: "assistant",
      content: botReply,
      timestamp: new Date().toISOString()
    });

    // Trim to max history length
    chatHistory[userId] = userHistory.slice(-MAX_HISTORY_LENGTH);
    longTermMemory[userId] = memory;

    logEvent('response', {
      userId,
      message: content,
      response: botReply,
      tokens: response.usage?.total_tokens
    });

    return botReply;
  } catch (error) {
    logEvent('error', {
      type: 'response_error',
      userId,
      error: error.message,
      stack: error.stack
    });
    return "Estoy agotado ahora, hablemos nuevamente más tarde.";
  }
}

// -----------------------------------
// Discord Client Setup
// -----------------------------------
discordClient.on('ready', () => {
  console.log(`${BOT_NAME} is ready!`);
  logEvent('system', { status: 'bot_ready' });
});

discordClient.on('messageCreate', async (message) => {
  // Ignore other bots or if shutting down
  if (message.author.bot || isShuttingDown) return;

  const userId = message.author.id;
  const content = message.content.toLowerCase();

  // -----------------------------------
  // 1) Quick local check to skip unneeded API calls
  // -----------------------------------
  // If it doesn't contain 'yue' or mention the bot, skip checking with shouldRespond()
  if (!content.includes('yue') && !message.mentions.has(discordClient.user)) {
    logEvent('ignore_local', { userId, message: content });
    return;
  }

  try {
    // -----------------------------------
    // 2) Check cooldown
    // -----------------------------------
    if (userCooldowns.has(userId)) {
      const lastTime = userCooldowns.get(userId);
      if (Date.now() - lastTime < COOLDOWN_MS) {
        logEvent('rate_limit', { userId });
        await message.react('⌛');
        return;
      }
    }

    // -----------------------------------
    // 3) (Optional) Check with shouldRespond API call
    // -----------------------------------
    // If the quick check above is not enough for your flow, do the deeper check:
    if (!(await shouldRespond(content))) {
      logEvent('ignore_api', { userId, message: content });
      return;
    }

    // -----------------------------------
    // 4) Generate and send response
    // -----------------------------------
    await message.channel.sendTyping();
    const botReply = await generateResponse(userId, message);

    await message.reply({
      content: botReply,
      allowedMentions: { repliedUser: false }
    });

    // Update user cooldown
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
// Initialize and Start
// -----------------------------------
await loadHistory();
await loadLongTermMemory();

// Reduced frequency for saving history and memory
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
