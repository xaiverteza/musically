const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require("discord.js");
const { Player } = require("discord-player");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

let adminPasswordHash = null;
let sessionToken = null;
let botToken = null;
let client = null;
let player = null;
let botReady = false;
let lastError = "";
let proxySetting = ""; // Displayed as a setting only; not applied to Discord gateway/voice traffic.

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};

function auth(req, res, next) {
  const supplied = req.get("x-dashboard-session") || "";
  if (!sessionToken || !safeEqual(supplied, sessionToken)) {
    return res.status(401).json({ error: "Please unlock the dashboard again." });
  }
  next();
}

function publicStatus() {
  return {
    locked: !sessionToken,
    configured: Boolean(client),
    botReady,
    bot: client && client.user ? {
      username: client.user.username,
      tag: client.user.tag,
      avatar: client.user.displayAvatarURL({ size: 128 })
    } : null,
    guilds: client ? client.guilds.cache.size : 0,
    lastError
  };
}

app.get("/api/status", (req, res) => res.json(publicStatus()));

app.post("/api/unlock", (req, res) => {
  const password = String(req.body.password || "");
  if (password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: "Use a dashboard password with at least 8 characters." });
  }
  if (!adminPasswordHash) {
    adminPasswordHash = hash(password);
    sessionToken = crypto.randomBytes(32).toString("hex");
    return res.json({ session: sessionToken, status: publicStatus(), firstSetup: true });
  }
  if (!safeEqual(hash(password), adminPasswordHash)) {
    return res.status(403).json({ error: "Wrong dashboard password." });
  }
  sessionToken = crypto.randomBytes(32).toString("hex");
  res.json({ session: sessionToken, status: publicStatus(), firstSetup: false });
});

app.post("/api/lock", auth, (req, res) => {
  sessionToken = null;
  res.json({ ok: true });
});

app.post("/api/bot/start", auth, async (req, res) => {
  const token = String(req.body.token || "").trim();
  if (!token) return res.status(400).json({ error: "Paste your Discord bot token." });
  if (client) return res.status(409).json({ error: "A bot is already running. Stop it before starting another." });

  try {
    botToken = token;
    const newClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
      ]
    });
    const newPlayer = new Player(newClient);
    newClient.once("ready", () => {
      botReady = true;
      lastError = "";
    });
    newClient.on("error", (err) => {
      lastError = String(err.message || err).slice(0, 300);
      console.error("Discord client error:", err);
    });
    newPlayer.events.on("playerError", (queue, error) => {
      lastError = String(error.message || error).slice(0, 300);
      console.error("Player error:", error);
    });
    newPlayer.events.on("error", (queue, error) => {
      lastError = String(error.message || error).slice(0, 300);
      console.error("Queue error:", error);
    });

    client = newClient;
    player = newPlayer;
    await newClient.login(token);
    res.json({ ok: true, message: "Bot login started. It may take a few seconds to appear online." });
  } catch (err) {
    lastError = String(err.message || err).slice(0, 300);
    botReady = false;
    botToken = null;
    if (client) {
      try { client.destroy(); } catch (_) {}
    }
    client = null;
    player = null;
    return res.status(400).json({ error: "Could not start the bot: " + lastError });
  }
});

app.post("/api/bot/stop", auth, async (req, res) => {
  try {
    if (player) {
      for (const queue of player.nodes.cache.values()) {
        try { queue.delete(); } catch (_) {}
      }
    }
    if (client) client.destroy();
  } catch (err) {
    console.error(err);
  }
  client = null;
  player = null;
  botToken = null;
  botReady = false;
  lastError = "";
  res.json({ ok: true });
});

function requireBot(res) {
  if (!client || !botReady || !player) {
    res.status(503).json({ error: "Start the Discord bot first and wait until it is online." });
    return false;
  }
  return true;
}

app.get("/api/guilds", auth, (req, res) => {
  if (!requireBot(res)) return;
  const guilds = client.guilds.cache.map(g => ({
    id: g.id,
    name: g.name,
    icon: g.iconURL({ size: 64 })
  }));
  res.json({ guilds });
});

app.get("/api/guilds/:guildId/channels", auth, (req, res) => {
  if (!requireBot(res)) return;
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: "Bot is not in that server. Invite it first." });
  const channels = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
    .map(c => ({ id: c.id, name: c.name, type: c.type }));
  res.json({ channels });
});

function getQueue(guildId) {
  const guild = client && client.guilds.cache.get(guildId);
  if (!guild) return { error: "Server not found. Make sure the bot is invited to that server." };
  const queue = player.nodes.get(guildId);
  return { guild, queue };
}

app.get("/api/queue/:guildId", auth, (req, res) => {
  if (!requireBot(res)) return;
  const result = getQueue(req.params.guildId);
  if (result.error) return res.status(404).json({ error: result.error });
  const q = result.queue;
  res.json({
    playing: Boolean(q && q.currentTrack),
    paused: Boolean(q && q.node.isPaused()),
    current: q && q.currentTrack ? {
      title: q.currentTrack.title,
      author: q.currentTrack.author,
      url: q.currentTrack.url,
      duration: q.currentTrack.duration,
      thumbnail: q.currentTrack.thumbnail
    } : null,
    tracks: q ? q.tracks.toArray().map(t => ({
      title: t.title, author: t.author, url: t.url, duration: t.duration,
      thumbnail: t.thumbnail
    })) : [],
    volume: q ? q.node.volume : 80,
    repeatMode: q ? q.repeatMode : 0
  });
});

app.post("/api/play", auth, async (req, res) => {
  if (!requireBot(res)) return;
  const { guildId, voiceChannelId, query } = req.body || {};
  if (!guildId || !voiceChannelId || !String(query || "").trim()) {
    return res.status(400).json({ error: "Choose a server, choose a voice channel, and enter a song or URL." });
  }
  const guild = client.guilds.cache.get(String(guildId));
  const voiceChannel = guild && guild.channels.cache.get(String(voiceChannelId));
  if (!guild || !voiceChannel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(voiceChannel.type)) {
    return res.status(400).json({ error: "That voice channel is not available." });
  }
  const me = guild.members.me;
  if (!me || !voiceChannel.permissionsFor(me).has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    return res.status(403).json({ error: "Give the bot Connect and Speak permissions in that voice channel." });
  }
  try {
    const searchResult = await player.search(String(query).trim(), { requestedBy: client.user });
    if (!searchResult || !searchResult.tracks.length) {
      return res.status(404).json({ error: "No playable results found. Try another search or a direct supported URL." });
    }
    let queue = player.nodes.get(guildId);
    if (!queue) {
      queue = player.nodes.create(guild, {
        metadata: { requestedByDashboard: true },
        volume: 80,
        leaveOnEmpty: true,
        leaveOnEmptyCooldown: 30000,
        leaveOnEnd: false,
        leaveOnStop: true,
        selfDeaf: true
      });
    }
    if (!queue.connection) await queue.connect(voiceChannel);
    queue.addTrack(searchResult.tracks[0]);
    if (!queue.node.isPlaying()) await queue.node.play();
    res.json({ ok: true, added: searchResult.tracks[0].title });
  } catch (err) {
    lastError = String(err.message || err).slice(0, 300);
    res.status(500).json({ error: "Playback failed: " + lastError });
  }
});

app.post("/api/control/:action", auth, async (req, res) => {
  if (!requireBot(res)) return;
  const { guildId, value } = req.body || {};
  if (!guildId) return res.status(400).json({ error: "Choose a server first." });
  const result = getQueue(String(guildId));
  if (result.error) return res.status(404).json({ error: result.error });
  const q = result.queue;
  const action = req.params.action;

  try {
    if (!q && !["stop"].includes(action)) {
      return res.status(400).json({ error: "Nothing is playing in that server yet." });
    }
    switch (action) {
      case "pause": q.node.setPaused(true); break;
      case "resume": q.node.setPaused(false); break;
      case "skip": if (!q.currentTrack) throw new Error("Nothing is playing."); q.node.skip(); break;
      case "stop": if (q) q.delete(); break;
      case "previous": if (!q || !q.history || !q.history.previousTrack) throw new Error("No previous track is available."); await q.history.back(); break;
      case "volume": {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("Volume must be between 0 and 100.");
        q.node.setVolume(n); break;
      }
      case "repeat": {
        const n = Number(value);
        if (![0, 1, 2, 3].includes(n)) throw new Error("Invalid repeat mode.");
        q.setRepeatMode(n); break;
      }
      case "remove": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n >= q.tracks.size) throw new Error("That queue position does not exist.");
        q.node.remove(n); break;
      }
      case "clear": q.clear(); break;
      default: return res.status(404).json({ error: "Unknown control." });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Musically dashboard listening on port ${PORT}`);
});