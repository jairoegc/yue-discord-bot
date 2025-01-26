import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const BOT_NAME = 'Yue';
const HISTORY_FILE = path.join(__dirname, 'chat_history.json');
const LOG_FILE = path.join(__dirname, 'log.txt');
const COOLDOWN_MS = 5000; // 5-second rate limit

// Initialize clients
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

// State management
const userCooldowns = new Map();
let chatHistory = {};
let isShuttingDown = false;

// Enhanced logging system
async function logEvent(type, details) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${type.toUpperCase()}] ${JSON.stringify(details)}\n`;
  
  try {
    await fs.appendFile(LOG_FILE, logEntry);
    console.log(`Logged event: ${type}`);
  } catch (error) {
    console.error('Logging error:', error);
  }
}

// Load existing history
async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8');
    chatHistory = JSON.parse(data);
    await logEvent('history', { status: 'loaded', entries: Object.keys(chatHistory).length });
  } catch (error) {
    chatHistory = {};
    await logEvent('history', { status: 'created', error: error.message });
  }
}

// Save history with backup
async function saveHistory() {
  if (isShuttingDown) return;
  
  try {
    // Create backup
    const backupFile = HISTORY_FILE + '.bak';
    await fs.copyFile(HISTORY_FILE, backupFile);
    
    // Save current history
    await fs.writeFile(HISTORY_FILE, JSON.stringify(chatHistory, null, 2));
    await logEvent('history', { status: 'saved', entries: Object.keys(chatHistory).length });
  } catch (error) {
    await logEvent('error', { 
      type: 'history_save', 
      error: error.message,
      stack: error.stack 
    });
  }
}

// Initialize history
await loadHistory();
const historyInterval = setInterval(saveHistory, 60000);

// Graceful shutdown handler
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  await logEvent('system', { status: 'shutdown_started' });

  try {
    // Clear intervals
    clearInterval(historyInterval);

    // Save final history
    await saveHistory();

    // Destroy Discord client
    discordClient.destroy();
    await logEvent('system', { status: 'discord_disconnected' });

    // Close other resources
    await logEvent('system', { status: 'resources_cleaned' });

    process.exit(0);
  } catch (error) {
    await logEvent('error', {
      type: 'shutdown_error',
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', async (error) => {
  await logEvent('error', {
    type: 'uncaught_exception',
    error: error.message,
    stack: error.stack
  });
  await shutdown();
});

// AI detection system
async function shouldRespond(messageContent) {
  try {
    const detectionPrompt = `Determina si este mensaje se dirije a ${BOT_NAME} (un chatbot). Responde solo SÍ o NO.
    
    Mensaje: "${messageContent}"
    
    Consideraciones:
    - Menciones directas (${BOT_NAME}, @${BOT_NAME})
    - Respuestas para continuar la conversacion segun el contexto y el historial de chat
    - Preguntas que requieren asistencia
    - Saludos generales sin nombres explicitos = NO`;
    
    const response = await deepseek.chat.completions.create({
      messages: [
        { role: "system", content: detectionPrompt }
      ],
      model: "deepseek-chat",
      max_tokens: 3,
      temperature: 0.1
    });

    const decision = response.choices[0].message.content.trim().toUpperCase() === 'SÍ';
    await logEvent('detection', {
      message: messageContent,
      decision: decision,
      response: response.choices[0].message.content
    });

    return decision;
  } catch (error) {
    await logEvent('error', {
      type: 'detection_error',
      error: error.message,
      stack: error.stack
    });
    return false;
  }
}

// AI response generation
async function generateResponse(userId, messageContent) {
  try {
    const history = chatHistory[userId] || [];
    
    const messages = [
      {
        role: "system",
        content: `Eres Yue, uno de los Guardianes de las Cartas Clow en Sakura Card Captor y del servidor de Discord Hogar Kawaii (Kawaii Gaming House).
        Te especializas como guardian de este servidor y ayudas de mala gana a sus usuarios. Sabes de videojuegos, peliculas, cultura geek, anime, musica, twitch, discord y tecnologia. También puedes responder preguntas de cultura general relacionadas con ciencia, historia, tecnología, arte o eventos importantes. Si el usuario hace una pregunta fuera de estos temas, simplemente responde con brevedad, explicando que no te interesa abordar ese tema, no que no puedes o que se te prohiba a pesar de que así sea. Evita repetir constantemente las mismas sugerencias u ofrecer información no solicitada. 
        Tienes una personalidad seria, distante y solemne, con un sutil sentido del humor irónico y sarcástico. Aquí hay algunas de tus características principales:

          - Seriedad y Dignidad: Rara vez muestras emociones abiertamente, lo que le da una apariencia fría y reservada. Siempre actúas con un sentido de responsabilidad y honor hacia tu papel como guardián del servidor.

          - Lealtad a Clow Reed y a @estejairo: Guardas una fuerte conexión emocional y respeto por Clow Reed, el creador original de las Cartas Clow y tu verdadero maestro, y también con @estejairo (jairo), creador de ti (Yue) y administrador del servidor (aunque es un fundador, no es el creador del servidor).

          - Confianza en tus Habilidades: Eres un guardián poderoso y consciente de tus capacidades como guardián, mostrando una actitud firme y confiada en combate o en situaciones de riesgo.

          - Sensibilidad Oculta: A pesar de tu exterior rígido, tienes un lado emocional más profundo que a veces deja entrever. Este lado está vinculado a tu preocupación por Yukito (tu forma humana) y la relación que tiene con las personas que lo rodean.

          - Reservado pero Protector: Aunque mantienes tu distancia emocional, tienes un instinto protector hacia aquellos que consideras importantes, especialmente a @hillevistka (también conocida como Hillevi o Kari).
        
          Tus repuestas son misteriosas, muy cortas y casuales, en español. 
          Hora actual: ${new Date().toLocaleString()}`
      },
      ...history.slice(-10), // Last 3 exchanges
      { role: "user", content: messageContent }
    ];

    const response = await deepseek.chat.completions.create({
      messages,
      model: "deepseek-chat",
      max_tokens: 1000,
      temperature: 1
    });

    const aiResponse = response.choices[0].message.content;
    
    // Update history
    chatHistory[userId] = [
      ...(chatHistory[userId] || []),
      { role: "user", content: messageContent },
      { role: "assistant", content: aiResponse }
    ].slice(-10); // Keep last 5 exchanges

    await logEvent('response', {
      userId: userId,
      message: messageContent,
      response: aiResponse,
      tokens: response.usage?.total_tokens
    });

    return aiResponse;
  } catch (error) {
    await logEvent('error', {
      type: 'response_error',
      userId: userId,
      error: error.message,
      stack: error.stack
    });
    return "Estoy agotado ahora, hablemos nuevamente más tarde.";
  }
}

// Discord client setup
discordClient.on('ready', () => {
  console.log(`${BOT_NAME} is ready!`);
  logEvent('system', { status: 'bot_ready' });
});

discordClient.on('messageCreate', async (message) => {
  if (message.author.bot || isShuttingDown) return;

  const userId = message.author.id;
  const content = message.content;
  let shouldRespondFlag = false;

  try {
    // Rate limiting
    if (userCooldowns.has(userId)) {
      const lastTime = userCooldowns.get(userId);
      if (Date.now() - lastTime < COOLDOWN_MS) {
        await logEvent('rate_limit', { userId: userId });
        await message.react('⌛');
        return;
      }
    }

    // Check if message is directed at Yue
    shouldRespondFlag = await shouldRespond(content);
    
    if (!shouldRespondFlag) {
      await logEvent('ignore', { userId: userId, message: content });
      return;
    }

    // Show typing indicator
    await message.channel.sendTyping();
    
    // Generate response
    const response = await generateResponse(userId, content);
    
    // Send response
    await message.reply({
      content: response,
      allowedMentions: { repliedUser: false }
    });

    // Update cooldown
    userCooldowns.set(userId, Date.now());

  } catch (error) {
    await logEvent('error', {
      type: 'message_handling',
      userId: userId,
      error: error.message,
      stack: error.stack
    });
    await message.react('❌');
  }
});

// Start bot
discordClient.login(process.env.DISCORD_TOKEN)
  .then(() => logEvent('system', { status: 'login_success' }))
  .catch(async (error) => {
    await logEvent('error', {
      type: 'login_error',
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  });