const express = require("express");
const path = require("path");
const crypto = require("crypto");
const {
  Client, GatewayIntentBits, ChannelType, PermissionFlagsBits,
  SlashCommandBuilder, ActivityType
} = require("discord.js");
const { Player } = require("discord-player");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

let adminPasswordHash = null;
let sessionToken = null;
let client = null;
let player = null;
let botReady = false;
let lastError = "";
// Custom proxy is intentionally not exposed as active: proxying Discord voice/gateway
// traffic requires a separate, tested transport implementation.

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
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
    bot: client?.user ? {
      username: client.user.username,
      tag: client.user.tag,
      avatar: client.user.displayAvatarURL({ size: 128 })
    } : null,
    guilds: client ? client.guilds.cache.size : 0,
    lastError
  };
}

const slashCommands = [
  new SlashCommandBuilder().setName("play").setDescription("Play a song or add it to the queue")
    .addStringOption(o => o.setName("song").setDescription("Song name or supported URL").setRequired(true)),
  new SlashCommandBuilder().setName("join").setDescription("Join your current voice channel"),
  new SlashCommandBuilder().setName("leave").setDescription("Stop playback and leave voice"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current track"),
  new SlashCommandBuilder().setName("previous").setDescription("Play the previous track"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop playback and clear the queue"),
  new SlashCommandBuilder().setName("queue").setDescription("Show the current queue"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Show the current track"),
  new SlashCommandBuilder().setName("volume").setDescription("Set volume from 0 to 100")
    .addIntegerOption(o => o.setName("amount").setDescription("Volume percentage").setMinValue(0).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName("loop").setDescription("Choose repeat mode")
    .addStringOption(o => o.setName("mode").setDescription("Repeat mode").setRequired(true)
      .addChoices({ name: "Off", value: "off" }, { name: "Track", value: "track" },
        { name: "Queue", value: "queue" }, { name: "Autoplay", value: "autoplay" })),
  new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle upcoming tracks"),
  new SlashCommandBuilder().setName("remove").setDescription("Remove a queued track by position")
    .addIntegerOption(o => o.setName("position").setDescription("Queue position, starting at 1").setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName("clear").setDescription("Clear upcoming tracks"),
  new SlashCommandBuilder().setName("seek").setDescription("Seek to a position in the current track")
    .addIntegerOption(o => o.setName("seconds").setDescription("Position in seconds").setMinValue(0).setRequired(true)),
  new SlashCommandBuilder().setName("ping").setDescription("Check bot latency"),
  new SlashCommandBuilder().setName("help").setDescription("List music commands")
].map(command => command.toJSON());

function createQueue(guild) {
  return player.nodes.create(guild, {
    metadata: {},
    volume: 80,
    leaveOnEmpty: true,
    leaveOnEmptyCooldown: 30000,
    leaveOnEnd: false,
    leaveOnStop: true,
    selfDeaf: true
  });
}

async function handleSlashCommand(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;

  try {
    if (name === "ping") {
      return interaction.reply({ content: `Pong! Gateway latency: ${client.ws.ping}ms`, ephemeral: true });
    }
    if (name === "help") {
      return interaction.reply({
        content: "**Musically commands**\n/play song • /join • /leave\n/pause • /resume • /skip • /previous • /stop\n/queue • /nowplaying • /volume amount • /loop mode\n/shuffle • /remove position • /clear • /seek seconds\n/ping • /help",
        ephemeral: true
      });
    }
    if (!interaction.guild) {
      return interaction.reply({ content: "Use this command inside a server.", ephemeral: true });
    }

    const guild = client.guilds.cache.get(interaction.guildId);
    if (!guild) return interaction.reply({ content: "I can't access this server. Check the bot invite and permissions.", ephemeral: true });

    let queue = player.nodes.get(guild.id);
    const voiceChannel = interaction.member?.voice?.channel;

    if (name === "play" || name === "join") {
      if (!voiceChannel) return interaction.reply({ content: "Join a voice channel first, then try again.", ephemeral: true });
      const permissions = voiceChannel.permissionsFor(guild.members.me);
      if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
        return interaction.reply({ content: "I need Connect and Speak permissions in that voice channel.", ephemeral: true });
      }

      queue = queue || createQueue(guild);
      if (!queue.connection) await queue.connect(voiceChannel);

      if (name === "join") {
        return interaction.reply({ content: `Joined **${voiceChannel.name}**.`, ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const query = interaction.options.getString("song", true).trim();
      const result = await player.search(query, { requestedBy: interaction.user });
      if (!result?.tracks?.length) {
        if (!queue.currentTrack && queue.tracks.size === 0) queue.delete();
        return interaction.editReply("No playable results found. Try another search or a supported URL.");
      }
      queue.addTrack(result.tracks[0]);
      if (!queue.node.isPlaying()) await queue.node.play();
      return interaction.editReply(`Added **${result.tracks[0].title}** to the queue.`);
    }

    if (name === "leave" || name === "stop") {
      if (queue) queue.delete();
      return interaction.reply({
        content: name === "leave" ? "Stopped playback and left voice." : "Playback stopped and queue cleared.",
        ephemeral: true
      });
    }

    if (!queue) return interaction.reply({ content: "Nothing is queued. Use /play first.", ephemeral: true });

    switch (name) {
      case "pause":
        queue.node.setPaused(true);
        return interaction.reply({ content: "Playback paused.", ephemeral: true });
      case "resume":
        queue.node.setPaused(false);
        return interaction.reply({ content: "Playback resumed.", ephemeral: true });
      case "skip":
        if (!queue.currentTrack) throw new Error("Nothing is playing right now.");
        queue.node.skip();
        return interaction.reply({ content: "Skipped the current track.", ephemeral: true });
      case "previous":
        if (!queue.history?.previousTrack) throw new Error("There is no previous track.");
        await queue.history.back();
        return interaction.reply({ content: "Playing the previous track.", ephemeral: true });
      case "queue": {
        const upcoming = queue.tracks.toArray().slice(0, 10);
        const lines = upcoming.map((track, i) => `${i + 1}. **${track.title}** — ${track.author}`);
        const current = queue.currentTrack ? `**Now playing:** ${queue.currentTrack.title}\n\n` : "";
        const list = lines.length ? `**Up next:**\n${lines.join("\n")}` : "No upcoming tracks.";
        const more = queue.tracks.size > 10 ? `\n…and ${queue.tracks.size - 10} more.` : "";
        return interaction.reply({ content: (current + list + more).slice(0, 1900), ephemeral: true });
      }
      case "nowplaying":
        return interaction.reply({
          content: queue.currentTrack
            ? `**${queue.currentTrack.title}**\nArtist: ${queue.currentTrack.author}\nDuration: ${queue.currentTrack.duration}`
            : "Nothing is playing right now.",
          ephemeral: true
        });
      case "volume": {
        const amount = interaction.options.getInteger("amount", true);
        queue.node.setVolume(amount);
        return interaction.reply({ content: `Volume set to ${amount}%.`, ephemeral: true });
      }
      case "loop": {
        const mode = interaction.options.getString("mode", true);
        queue.setRepeatMode(({ off: 0, track: 1, queue: 2, autoplay: 3 })[mode]);
        return interaction.reply({ content: `Repeat mode set to **${mode}**.`, ephemeral: true });
      }
      case "shuffle":
        if (!queue.tracks.size) throw new Error("There are no upcoming tracks to shuffle.");
        queue.tracks.shuffle();
        return interaction.reply({ content: "Shuffled the upcoming queue.", ephemeral: true });
      case "remove": {
        const index = interaction.options.getInteger("position", true) - 1;
        if (index < 0 || index >= queue.tracks.size) throw new Error("That queue position does not exist.");
        queue.node.remove(index);
        return interaction.reply({ content: "Removed that track from the queue.", ephemeral: true });
      }
      case "clear":
        queue.clear();
        return interaction.reply({ content: "Cleared upcoming tracks.", ephemeral: true });
      case "seek": {
        if (!queue.currentTrack) throw new Error("Nothing is playing right now.");
        const seconds = interaction.options.getInteger("seconds", true);
        const duration = Number(queue.currentTrack.durationMS || 0);
        if (duration && seconds * 1000 > duration) throw new Error("That position is past the end of this track.");
        await queue.node.seek(seconds * 1000);
        return interaction.reply({ content: `Seeked to ${seconds} seconds.`, ephemeral: true });
      }
      default:
        return interaction.reply({ content: "Unknown command. Try /help.", ephemeral: true });
    }
  } catch (error) {
    const content = String(error.message || error).slice(0, 1500);
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp({ content, ephemeral: true }).catch(() => {});
    }
    return interaction.reply({ content, ephemeral: true }).catch(() => {});
  }
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
  return res.json({ session: sessionToken, status: publicStatus(), firstSetup: false });
});

app.post("/api/lock", auth, (req, res) => {
  sessionToken = null;
  res.json({ ok: true });
});

app.post("/api/bot/start", auth, async (req, res) => {
  const token = String(req.body.token || "").trim();
  if (!token) return res.status(400).json({ error: "Paste your Discord bot token." });
  if (client) return res.status(409).json({ error: "A bot is already running. Stop it before starting another." });

  let newClient;
  try {
    newClient = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
    });
    const newPlayer = new Player(newClient);

    // Register the default extractors before accepting searches.
    await newPlayer.extractors.loadDefault();

    newClient.once("ready", async () => {
      botReady = true;
      lastError = "";
      try {
        newClient.user.setActivity("music commands • /help", { type: ActivityType.Listening });
        // Guild commands appear quickly and are refreshed for every server the bot joins.
        for (const guild of newClient.guilds.cache.values()) {
          try { await guild.commands.set(slashCommands); }
          catch (error) { console.error("Command registration failed for guild", guild.id, error); }
        }
    } catch (error) {
        lastError = `Command registration: ${String(error.message || error).slice(0, 220)}`;
        console.error(lastError);
      }
    });

    newClient.on("guildCreate", guild => {
      guild.commands.set(slashCommands).catch(error => console.error("Command registration failed:", error));
    });
    newClient.on("interactionCreate", handleSlashCommand);
    newClient.on("error", error => {
      lastError = String(error.message || error).slice(0, 300);
      console.error("Discord client error:", error);
    });
    newPlayer.events.on("playerError", (_queue, error) => {
      lastError = String(error.message || error).slice(0, 300);
      console.error("Player error:", error);
    });
    newPlayer.events.on("error", (_queue, error) => {
      lastError = String(error.message || error).slice(0, 300);
      console.error("Queue error:", error);
    });

    client = newClient;
    player = newPlayer;
    botReady = false;
    lastError = "";
    await newClient.login(token);
    res.json({ ok: true, message: "Bot login started. Wait a few seconds for it to appear online." });
  } catch (error) {
    lastError = String(error.message || error).slice(0, 300);
    botReady = false;
    if (newClient) {
      try { newClient.destroy(); } catch (_) {}
    }
    client = null;
    player = null;
    return res.status(400).json({ error: "Could not start the bot: " + lastError });
  }
});

app.post("/api/bot/stop", auth, async (_req, res) => {
  try {
    if (player) {
      for (const queue of player.nodes.cache.values()) {
        try { queue.delete(); } catch (_) {}
      }
    }
    if (client) client.destroy();
  } catch (error) {
    console.error(error);
  }
  client = null;
  player = null;
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
  res.json({ guilds: client.guilds.cache.map(guild => ({
    id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 })
  })) });
});

app.get("/api/guilds/:guildId/channels", auth, (req, res) => {
  if (!requireBot(res)) return;
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: "Bot is not in that server. Invite it first." });
  const channels = guild.channels.cache
    .filter(channel => [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type))
    .map(channel => ({ id: channel.id, name: channel.name, type: channel.type }));
  res.json({ channels });
});

function getQueue(guildId) {
  const guild = client && client.guilds.cache.get(guildId);
  if (!guild) return { error: "Server not found. Make sure the bot is invited to that server." };
  return { guild, queue: player.nodes.get(guildId) };
}

app.get("/api/queue/:guildId", auth, (req, res) => {
  if (!requireBot(res)) return;
  const result = getQueue(req.params.guildId);
  if (result.error) return res.status(404).json({ error: result.error });
  const queue = result.queue;
  res.json({
    playing: Boolean(queue && queue.currentTrack),
    paused: Boolean(queue && queue.node.isPaused()),
    current: queue?.currentTrack ? {
      title: queue.currentTrack.title, author: queue.currentTrack.author,
      url: queue.currentTrack.url, duration: queue.currentTrack.duration,
      thumbnail: queue.currentTrack.thumbnail
    } : null,
    tracks: queue ? queue.tracks.toArray().map(track => ({
      title: track.title, author: track.author, url: track.url,
      duration: track.duration, thumbnail: track.thumbnail
    })) : [],
    volume: queue ? queue.node.volume : 80,
    repeatMode: queue ? queue.repeatMode : 0
  });
});

app.post("/api/play", auth, async (req, res) => {
  if (!requireBot(res)) return;
  const { guildId, voiceChannelId, query } = req.body || {};
  if (!guildId || !voiceChannelId || !String(query || "").trim()) {
    return res.status(400).json({ error: "Choose a server, voice channel, and song or URL." });
  }
  const guild = client.guilds.cache.get(String(guildId));
  const voiceChannel = guild && guild.channels.cache.get(String(voiceChannelId));
  if (!guild || !voiceChannel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(voiceChannel.type)) {
    return res.status(400).json({ error: "That voice channel is not available." });
  }
  const me = guild.members.me;
  if (!me || !voiceChannel.permissionsFor(me)?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    return res.status(403).json({ error: "Give the bot Connect and Speak permissions in that voice channel." });
  }
  try {
    const result = await player.search(String(query).trim(), { requestedBy: client.user });
    if (!result?.tracks?.length) return res.status(404).json({ error: "No playable results found. Try another search or supported URL." });
    let queue = player.nodes.get(guildId);
    if (!queue) queue = createQueue(guild);
    if (!queue.connection) await queue.connect(voiceChannel);
    queue.addTrack(result.tracks[0]);
    if (!queue.node.isPlaying()) await queue.node.play();
    res.json({ ok: true, added: result.tracks[0].title });
  } catch (error) {
    lastError = String(error.message || error).slice(0, 300);
    res.status(500).json({ error: "Playback failed: " + lastError });
  }
});

app.post("/api/control/:action", auth, async (req, res) => {
  if (!requireBot(res)) return;
  const { guildId, value } = req.body || {};
  if (!guildId) return res.status(400).json({ error: "Choose a server first." });
  const result = getQueue(String(guildId));
  if (result.error) return res.status(404).json({ error: result.error });
  const queue = result.queue;
  const action = req.params.action;

  try {
    if (!queue && action !== "stop") return res.status(400).json({ error: "Nothing is playing in that server yet." });
    switch (action) {
      case "pause": queue.node.setPaused(true); break;
      case "resume": queue.node.setPaused(false); break;
      case "skip": if (!queue.currentTrack) throw new Error("Nothing is playing."); queue.node.skip(); break;
      case "stop": if (queue) queue.delete(); break;
      case "previous": if (!queue?.history?.previousTrack) throw new Error("No previous track is available."); await queue.history.back(); break;
      case "volume": {
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount < 0 || amount > 100) throw new Error("Volume must be between 0 and 100.");
        queue.node.setVolume(amount); break;
      }
      case "repeat": {
        const mode = Number(value);
        if (![0, 1, 2, 3].includes(mode)) throw new Error("Invalid repeat mode.");
        queue.setRepeatMode(mode); break;
      }
      case "remove": {
        const index = Number(value);
        if (!Number.isInteger(index) || index < 0 || index >= queue.tracks.size) throw new Error("That queue position does not exist.");
        queue.node.remove(index); break;
      }
      case "clear": queue.clear(); break;
      default: return res.status(404).json({ error: "Unknown control." });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: String(error.message || error) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, "0.0.0.0", () => console.log(`Musically dashboard listening on port ${PORT}`));
