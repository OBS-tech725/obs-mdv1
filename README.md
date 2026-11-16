# OBS MD — WhatsApp AI Bot for Android / Termux

## Features
- English and Kiswahili AI replies in private chats
- Image understanding
- Best-effort archive of incoming ordinary text and supported media
- Owner notifications when an archived message is deleted
- Owner commands to search and retrieve archived items
- Owner-only group moderation (kick/promote/demote), when both owner and bot are group admins
- Group participant display-name list (not bulk phone-number harvesting)
- Group membership change alerts
- Incoming call alerts (no outgoing spam calls)
- Airtel-data-friendly saver mode (media downloads disabled by default)
- Owner controls for data saver and optional media downloads
- Automatic reconnect and best-effort chat-scoped online presence refresh

## Important limitations
- Anti-delete archives content received and saved while connected; it cannot stop deletion on other phones or recover messages missed while offline.
- View-once content is deliberately not archived.
- Status access is not bypassed. View/save statuses through WhatsApp's normal interface and permissions.
- Online presence is not guaranteed 24/7; WhatsApp presence is chat-scoped and expires quickly, while Android may suspend Termux or the internet connection may drop.
- Data saver reduces media downloads; it does not create free data or bypass Airtel charges. Text replies still use data and OpenAI API calls may incur separate charges.
- No spam calls, unsolicited mass messaging, or covert group-contact scraping.
- Cannot override group-admin permissions or reverse another admin's decision.
- Baileys is an unofficial WhatsApp Web integration and may cause account restrictions or break after WhatsApp changes.

## Install
1. Install Termux from F-Droid or official Termux GitHub releases.
2. In Termux:
   ```bash
   pkg update && pkg upgrade -y
   pkg install nodejs-lts unzip nano -y
   node -v
   ```
   Use Node.js 20 or newer.
3. Extract this ZIP and enter the project directory:
   ```bash
   cd OBS-MD
   npm install
   cp .env.example .env
   nano .env
   ```
4. Add your OpenAI API key and owner number. API key: https://platform.openai.com/api-keys
   OWNER_NUMBER uses digits only in international format, e.g. 2557XXXXXXXX. Use a different number from the WhatsApp account linked as the bot.
5. For best-effort background operation, install Termux:Boot and Termux:API from the same trusted source as Termux if available, then run `termux-wake-lock` before starting the bot. Exclude Termux from Android battery optimization and keep mobile data enabled. A wake lock cannot prevent every Android/OEM shutdown.
6. Run:
   ```bash
   npm start
   ```
7. Scan QR using WhatsApp > Linked devices > Link a device.

## Commands
Public: `!help`, `!ping`, `!time`, `!about`, `!reset`
Owner: `!find keyword`, `!recent`, `!get ARCHIVE_ID`, `!groups`
Owner in a group where owner and bot are admins: `!members`, `!kick @mention`, `!promote @mention`, `!demote @mention`
Owner: `!ai on`, `!ai off`, `!online on`, `!online off`, `!datasaver on/off`, `!media on/off`

Archive files are stored under `archive/`. Protect `.env`, `auth_info/`, and `archive/`. Messages and images sent for AI processing are transmitted to OpenAI. API billing is separate from a ChatGPT subscription. Tell group members if you are archiving their messages and media; respect consent, group rules, copyright and WhatsApp terms.

## Airtel data-saving controls
- `!datasaver on` keeps media downloads disabled by default.
- `!media on` allows OBS MD to download incoming media (including images for AI analysis); this can use substantial data.
- `!media off` disables those downloads again.
- `!datasaver off` disables the saver flag but does not automatically enable media downloads.
- Airtel bundle availability and prices are controlled by Airtel. Check `*149*99#` or the official Airtel Tanzania data-bundles page before purchasing.
