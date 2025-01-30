# Yue Discord Bot

**Yue** is a spanish-speaking Discord bot designed to maintain a single conversation shared among all users, with a shared long-term memory. It leverages the [discord.js](https://discord.js.org/) library for bot interactions and [OpenAI](https://www.npmjs.com/package/openai) (DeepSeek endpoint) for generating text responses.

---

## Features

1. **Shared Conversation**: All messages go into a single, global history.
2. **Shared Memory**: A single `long_term_memory.json` file stores overall knowledge, summaries, and facts.
3. **Mention/Keyword Trigger**: Yue responds if mentioned with `@Yue` or if certain keywords (like `"yue"`) appear in the message.
4. **Cooldown**: A short cooldown (8 seconds by default) to prevent spam or overload.
5. **Condensed Summaries**: Periodically summarizes the last N messages to keep the conversation context smaller.

---

## Prerequisites

1. **Node.js** (16+ recommended).
2. **A Discord Application**:
   - Go to [Discord Developer Portal](https://discord.com/developers/applications).
   - Create a new application (e.g., `YueBot`).
   - Under **Bot** section, click **Add Bot**.
   - Copy the **Token** (this will be your `DISCORD_TOKEN`).
3. **Permissions / Invite**:
   - In **OAuth2** => **URL Generator**, check `bot` and `applications.commands`.
   - Under **Bot Permissions**, select (as a minimum) `Send Messages` and `Read Messages/View Channels`.
   - Copy the generated URL and **invite** the bot to your server.

---

## Setup

1. **Clone or Download** this repository.
2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. Create .env file with your secrets:
    ```bash ini
    APP_ID=YOUR_DISCORD_APP_ID
    PUBLIC_KEY=YOUR_DISCORD_PUBLIC_KEY
    DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
    DEEPSEEK_API_KEY=YOUR_DEEPSEEK_API_KEY
    ```
4. Run the Bot:
    ```bash
    node app.js
    ```

---

## Usage

1. Run node app.js.
2. Check your server. Once online, Yue will log "login_success" in log.txt.
3. Interact by mentioning @Yue in chat, or use keywords like "yue".
4. Cooldown: If you spam commands within 8 seconds, it may ignore or react with ⌛.

---

## How to Invite the Bot

1. Go to the Discord Developer Portal.
2. Select your bot.
3. OAuth2 > URL Generator:
    * Check bot under Scopes.
    * Under Bot Permissions, enable at least the following:
        * Send Messages
        * Read Message History
        * Add Reactions (optional, if you want reaction usage)
    * Copy the Generated URL.
    * Open that URL in your browser.
    * Select the server you want to add the bot to and authorize it.

---

## Running

* Local:

    ```bash
    node app.js
    ```
    The bot will connect to Discord. Press Ctrl + C to stop it.

* Production (optional):
    * Use a process manager like pm2 or forever.
    * Ensure .env is present or environment variables are set.

---

## Logging

* Logs are written to log.txt.
* Console logs are also appended to log.txt.
* On shutdown (Ctrl + C), the bot attempts to save state and memory.

---

## Contributing

* Fork this repository.
* Make your changes in a branch.
* Submit a Pull Request for review.

---

## License

MIT License.

Feel free to modify and adapt to your needs.