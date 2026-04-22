// ================================================================
// ANUA SEEDING BOT — Node.js Gateway Bot
// ================================================================

const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

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

// ── Persistent pending store ────────────────────────────────
// Stored as a JSON file so button clicks work even after restarts
const PENDING_FILE = path.join('/tmp', 'pending.json');

function loadPending() {
  try {
    if (fs.existsSync(PENDING_FILE)) {
      return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    }
  } catch(e) { console.error('loadPending error:', e.message); }
  return {};
}

function savePending(pending) {
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(pending), 'utf8');
  } catch(e) { console.error('savePending error:', e.message); }
}

function getPending(messageId) {
  return loadPending()[messageId] || null;
}

function setPending(messageId, data) {
  const pending = loadPending();
  pending[messageId] = data;
  savePending(pending);
}

function deletePending(messageId) {
  const pending = loadPending();
  delete pending[messageId];
  savePending(pending);
}

// ── URL helpers ─────────────────────────────────────────────
function isValidVideoUrl(url) {
  return [
    /https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s<>"]+/i,
    /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p)\/[^\s<>"]+/i,
    /https?:\/\/(?:www\.)?youtube\.com\/shorts\/[^\s<>"]+/i,
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?[^\s<>"]+/i,
    /https?:\/\/youtu\.be\/[^\s<>"]+/i,
  ].some(p => p.test(url));
}

function extractUrl(content) {
  const match = content.match(/https?:\/\/[^\s<>"]+/i);
  return match ? match[0] : null;
}

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

function detectPlatform(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('tiktok.com'))                             return 'TikTok';
  if (u.includes('instagram.com'))                          return 'Instagram';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
  return 'Unknown';
}

function extractHandle(url) {
  const tt = url.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i);
  if (tt) return '@' + tt[1];
  const ig = url.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:reel|p)\//i);
  if (ig) return '@' + ig[1];
  const yt = url.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i);
  if (yt) return '@' + yt[1];
  return null;
}

// ── Log to Apps Script ──────────────────────────────────────
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

// ── Message listener ────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const channelName = message.channel.name || '';
  if (!SUBMISSION_CHANNELS.includes(channelName)) return;

  const server = SERVERS[message.guildId];
  if (!server) return;

  const rawUrl = extractUrl(message.content);
  if (!rawUrl) return;

  if (!isValidVideoUrl(rawUrl)) {
    await message.reply(
      `❌ That doesn't look like a valid TikTok, Instagram Reel, or YouTube link.\n` +
      `Please paste a direct video link.`
    );
    return;
  }

  const link = normalizeUrl(rawUrl);

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

  // Store in persistent file so button clicks work after restarts
  setPending(prompt.id, {
    link,
    project:   server.name,
    userId:    message.author.id,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  // Auto-expire after 5 minutes
  setTimeout(async () => {
    const state = getPending(prompt.id);
    if (state) {
      deletePending(prompt.id);
      try {
        await prompt.edit({ content: '⏱️ Product selection timed out.', components: [] });
      } catch {}
    }
  }, 5 * 60 * 1000);
});

// ── Button interaction listener ─────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const state = getPending(interaction.message.id);

  if (!state || Date.now() > state.expiresAt) {
    await interaction.reply({ content: '⏱️ This selection has expired. Please paste your link again.', ephemeral: true });
    if (state) deletePending(interaction.message.id);
    return;
  }

  if (interaction.user.id !== state.userId) {
    await interaction.reply({ content: '❌ Only the person who posted the link can select the product.', ephemeral: true });
    return;
  }

  const productEntry = Object.entries(PRODUCTS).find(
    ([, val]) => val.buttonId === interaction.customId
  );
  if (!productEntry) {
    await interaction.reply({ content: '❌ Unknown product.', ephemeral: true });
    return;
  }

  const [productKey, productInfo] = productEntry;

  // Acknowledge immediately to prevent "interaction failed"
  await interaction.deferUpdate();

  const result = await logToSheet(state.link, productKey, state.project);
  deletePending(interaction.message.id);

  if (result?.duplicate) {
    await interaction.editReply({
      content: `⚠️ <@${state.userId}> This link has already been submitted — duplicate detected!`,
      components: [],
    });
    return;
  }

  if (!result?.success) {
    await interaction.editReply({
      content: `⚠️ <@${state.userId}> Something went wrong logging your submission. Please try again or contact an admin.\n\`${result?.error || 'unknown error'}\``,
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
client.once('clientReady', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  console.log(`   Watching channels: ${SUBMISSION_CHANNELS.join(', ')}`);
  console.log(`   Active products: ${Object.keys(PRODUCTS).join(', ')}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
