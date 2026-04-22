// ================================================================
// ANUA SEEDING BOT — Node.js Gateway Bot
// Deploy on Railway or Render (free tier)
//
// FLOW:
//   1. Seeder pastes a video link in #content-submission or
//      #content-submission📸
//   2. Bot replies with 3 product buttons
//   3. Seeder clicks a button
//   4. Bot logs link + product + country to Apps Script (무가시딩)
//   5. Bot confirms ✅ and cleans up the button message
//
// ENV VARS NEEDED:
//   DISCORD_BOT_TOKEN     — bot token from Discord Developer Portal
//   APPS_SCRIPT_POST_URL  — deployed web app URL from ContentSubmissionSync.gs
//
// INSTALL:
//   npm install discord.js node-fetch
//
// START:
//   node bot.js
// ================================================================

const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fetch = require('node-fetch');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── Config ──────────────────────────────────────────────────
const SUBMISSION_CHANNELS = ['content-submission', 'content-submission📸'];

const SERVERS = {
  '1488821315048701972': { name: 'AU' },
  '1456468324568273037': { name: 'CA' },
};

// Active products — update when drops change
const PRODUCTS = {
  'PDRN': {
    label:    'PDRN Serum Spray',
    drop:     'Drop 05',
    buttonId: 'product_PDRN',
    emoji:    '💧',
  },
  'RICE': {
    label:    'Rice Line',
    drop:     'Drop 04',
    buttonId: 'product_RICE',
    emoji:    '🌾',
  },
  'PDRN DISCOVERY SET': {
    label:    'PDRN Discovery Set',
    drop:     'Mini Challenge 2',
    buttonId: 'product_PDRN_DISCOVERY_SET',
    emoji:    '✨',
  },
};

// ── URL validation ──────────────────────────────────────────
function isValidVideoUrl(url) {
  return [
    /https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s<>"]+/i,
    /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p)\/[^\s<>"]+/i,
    /https?:\/\/(?:www\.)?youtube\.com\/shorts\/[^\s<>"]+/i,
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?[^\s<>"]+/i,
    /https?:\/\/youtu\.be\/[^\s<>"]+/i,
  ].some(p => p.test(url));
}

// ── Extract first URL from a message ───────────────────────
function extractUrl(content) {
  const match = content.match(/https?:\/\/[^\s<>"]+/i);
  return match ? match[0] : null;
}

// ── Normalize URL ───────────────────────────────────────────
function normalizeUrl(raw) {
  if (!raw) return raw;
  let url = raw.trim();
  if (url.includes('tiktok.com')) {
    if (!url.includes('vm.tiktok.com') && !url.includes('vt.tiktok.com')) {
      url = url.split('?')[0];
    }
    return url.replace(/\/$/, '');
  }
  if (url.includes('instagram.com')) {
    const match = url.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
    if (match) return `https://www.instagram.com/reel/${match[1]}/`;
    return url.split('?')[0].replace(/\/$/, '') + '/';
  }
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    const watch  = url.match(/[?&]v=([A-Za-z0-9_-]+)/);
    if (watch)   return `https://www.youtube.com/watch?v=${watch[1]}`;
    const shorts = url.match(/\/shorts\/([A-Za-z0-9_-]+)/);
    if (shorts)  return `https://www.youtube.com/shorts/${shorts[1]}`;
    const ytbe   = url.match(/youtu\.be\/([A-Za-z0-9_-]+)/);
    if (ytbe)    return `https://www.youtube.com/watch?v=${ytbe[1]}`;
  }
  return url;
}

// ── Detect platform ─────────────────────────────────────────
function detectPlatform(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('tiktok.com'))                             return 'TikTok';
  if (u.includes('instagram.com'))                          return 'Instagram';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
  return 'Unknown';
}

// ── Extract handle from URL ─────────────────────────────────
function extractHandle(url) {
  const tt = url.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i);
  if (tt) return '@' + tt[1];
  const ig = url.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:reel|p)\//i);
  if (ig) return '@' + ig[1];
  const yt = url.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i);
  if (yt) return '@' + yt[1];
  return null;
}

// ── Send to Apps Script ─────────────────────────────────────
async function logToSheet(link, productKey, project) {
  try {
    const res  = await fetch(process.env.APPS_SCRIPT_POST_URL, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      body:     JSON.stringify({ link, product: productKey, project }),
      redirect: 'follow',
    });
    const text = await res.text();
    console.log('Apps Script →', text);
    try { return JSON.parse(text); } catch { return { success: false, error: text }; }
  } catch (e) {
    console.error('logToSheet error:', e.message);
    return { success: false, error: e.message };
  }
}

// ── Pending interactions ────────────────────────────────────
// Stores { link, project, userId, originalMessageId } keyed by button message ID
// so we know what to log when a button is clicked
const pending = new Map();

// ── Message listener ────────────────────────────────────────
client.on('messageCreate', async (message) => {
  // Ignore bots
  if (message.author.bot) return;

  // Only watch submission channels
  const channelName = message.channel.name || '';
  if (!SUBMISSION_CHANNELS.includes(channelName)) return;

  // Only handle configured servers
  const server = SERVERS[message.guildId];
  if (!server) return;

  // Extract and validate URL
  const rawUrl = extractUrl(message.content);
  if (!rawUrl) return; // No URL in message — ignore silently
  if (!isValidVideoUrl(rawUrl)) {
    // Has a URL but it's not a valid video — gently flag it
    await message.reply(
      `❌ That doesn't look like a valid TikTok, Instagram Reel, or YouTube link.\n` +
      `Please paste a direct video link.`
    );
    return;
  }

  const link = normalizeUrl(rawUrl);

  // Build product selection buttons
  const row = new ActionRowBuilder().addComponents(
    ...Object.entries(PRODUCTS).map(([key, val]) =>
      new ButtonBuilder()
        .setCustomId(val.buttonId)
        .setLabel(`${val.emoji} ${val.label}`)
        .setStyle(ButtonStyle.Secondary)
    )
  );

  const prompt = await message.reply({
    content: `<@${message.author.id}> Which product is this for?`,
    components: [row],
  });

  // Store pending state keyed by the button message ID
  pending.set(prompt.id, {
    link,
    project:           server.name,
    userId:            message.author.id,
    originalMessageId: message.id,
    channelId:         message.channelId,
  });

  // Auto-expire after 5 minutes if no button clicked
  setTimeout(() => {
    if (pending.has(prompt.id)) {
      pending.delete(prompt.id);
      prompt.edit({ content: '⏱️ Product selection timed out.', components: [] }).catch(() => {});
    }
  }, 5 * 60 * 1000);
});

// ── Button interaction listener ─────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  // Find the pending entry for this button message
  const state = pending.get(interaction.message.id);
  if (!state) {
    await interaction.reply({ content: '⏱️ This selection has expired.', ephemeral: true });
    return;
  }

  // Only the original poster can click the button
  if (interaction.user.id !== state.userId) {
    await interaction.reply({ content: '❌ Only the person who posted the link can select the product.', ephemeral: true });
    return;
  }

  // Map button ID back to product key
  const productKey = Object.entries(PRODUCTS).find(
    ([, val]) => val.buttonId === interaction.customId
  )?.[0];

  if (!productKey) {
    await interaction.reply({ content: '❌ Unknown product.', ephemeral: true });
    return;
  }

  const productInfo = PRODUCTS[productKey];

  // Defer so Discord doesn't time out while we call Apps Script
  await interaction.deferUpdate();

  // Log to sheet
  const result = await logToSheet(state.link, productKey, state.project);

  // Clean up pending state
  pending.delete(interaction.message.id);

  if (result?.duplicate) {
    await interaction.editReply({
      content: `⚠️ <@${state.userId}> This link has already been submitted — duplicate detected!`,
      components: [],
    });
    return;
  }

  if (!result?.success) {
    await interaction.editReply({
      content: `⚠️ <@${state.userId}> Something went wrong. Please try again or contact an admin.`,
      components: [],
    });
    return;
  }

  const handle   = extractHandle(state.link) || interaction.user.username;
  const platform = detectPlatform(state.link);

  await interaction.editReply({
    content:
      `✅ <@${state.userId}> Content logged!\n` +
      `📎 ${state.link}\n` +
      `🛍️ ${productInfo.emoji} ${productInfo.label} · ${productInfo.drop}\n` +
      `🌍 ${state.project} · ${handle} · ${platform}`,
    components: [],
  });
});

// ── Start ───────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  console.log(`   Watching channels: ${SUBMISSION_CHANNELS.join(', ')}`);
  console.log(`   Active products: ${Object.keys(PRODUCTS).join(', ')}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
