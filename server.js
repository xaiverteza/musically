const express = require("express");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ActivityType
} = require("discord.js");
const { Player } = require("discord-player");

const app = express();
const PORT = process.env.PORT || 3000;
const OWNER_ID = "1488177833925808318";

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

app.use(session({
  name: "musically.sid",
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

let client = null;
let player = null;
let botReady = false;
let lastError = "";
let oauthState = new Map();

const OWNER_AUTH_REQUIRED = Boolean(
  process.env.DISCORD_CLIENT_ID &&
  process.env.DISCORD_CLIENT_SECRET &&
  process.env.DISCORD_REDIRECT_URI
);

function requireOwner(req, res, next) {
  if (OWNER_AUTH_REQUIRED) {
    if (req.session?.discordUser?.id !== OWNER_ID) {
      return res.status(401).json({
        error: "Sign in with the authorized Discord owner account first."
      });
    }
  } else if (req.session?.localUnlocked !== true) {
    return res.status(401).json({
      error: "Dashboard locked. Configure Discord OAuth2 or unlock local access."
    });
  }
  next();
}

function status() {
  return {
    locked: false,
    oauthConfigured: OWNER_AUTH_REQUIRED,
    configured: Boolean(client),
    botReady,
    bot: client?.user ? {
      username: client.user.username,
      tag: client.user.tag,
      avatar: client.user.displayAvatarURL({ size: 128 })
    } : null,
    guilds: client?.guilds.cache.size || 0,
    lastError
  };
}

const commands = [
  new SlashCommandBuilder().setName("play")
    .setDescription("Play a song")
    .addStringOption(o => o.setName("song")
      .setDescription("Song name or URL").setRequired(true)),
  new SlashCommandBuilder().setName("join").setDescription("Join your voice channel"),
  new SlashCommandBuilder().setName("leave").setDescription("Stop and leave voice"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip current track"),
  new SlashCommandBuilder().setName("previous").setDescription("Play previous track"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop and clear queue"),
  new SlashCommandBuilder().setName("queue").setDescription("Show the queue"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Show current track"),
  new SlashCommandBuilder().setName("volume")
    .setDescription("Set volume")
    .addIntegerOption(o => o.setName("amount")
      .setDescription("0 to 100").setMinValue(0)
      .setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName("loop")
    .setDescription("Change repeat mode")
    .addStringOption(o => o.setName("mode")
      .setDescription("Repeat mode").setRequired(true)
      .addChoices(
        { name: "Off", value: "off" },
        { name: "Track", value: "track" },
        { name: "Queue", value: "queue" },
        { name: "Autoplay", value: "autoplay" }
      )),
  new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle queue"),
  new SlashCommandBuilder().setName("clear").setDescription("Clear upcoming tracks"),
  new SlashCommandBuilder().setName("ping").setDescription("Check bot latency"),
  new SlashCommandBuilder().setName("help").setDescription("Show music commands")
].map(command => command.toJSON());

/* Discord OAuth2 login */

app.get("/auth/discord", (req, res) => {
  if (!OWNER_AUTH_REQUIRED) {
    return res.status(503).send(
      "Discord OAuth2 is not configured. Add the Discord application credentials and callback URL in hosting settings."
    );
  }

  const state = crypto.randomBytes(24).toString("hex");
  oauthState.set(state, Date.now());

  for (const [key, time] of oauthState) {
    if (Date.now() - time > 10 * 60 * 1000) oauthState.delete(key);
  }

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state
  });

  res.redirect("https://discord.com/oauth2/authorize?" + params);
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!OWNER_AUTH_REQUIRED || typeof state !== "string" ||
      !oauthState.has(state) || typeof code !== "string") {
    return res.status(400).send("Invalid or expired Discord login request.");
  }

  oauthState.delete(state);

  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      })
    });

    if (!tokenResponse.ok) throw new Error("Discord token exchange failed.");
    const tokens = await tokenResponse.json();

    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    if (!userResponse.ok) throw new Error("Discord profile request failed.");
    const user = await userResponse.json();

    if (user.id !== OWNER_ID) {
      return res.status(403).send("Access denied. This Discord account is not the owner.");
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate(err => err ? reject(err) : resolve());
    });

    req.session.discordUser = {
      id: user.id,
      username: user.username,
      avatar: user.avatar || null
    };

    res.redirect("/");
  } catch (error) {
    console.error("Discord OAuth2 error:", error.message);
    res.status(502).send("Discord login failed. Check OAuth2 settings and try again.");
  }
});

app.get("/auth/me", (req, res) => {
  res.json({
    authenticated: OWNER_AUTH_REQUIRED
      ? req.session?.discordUser?.id === OWNER_ID
      : req.session?.localUnlocked === true,
    owner: req.session?.discordUser || null,
    oauthConfigured: OWNER_AUTH_REQUIRED
  });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("musically.sid");
    res.json({ ok: true });
  });
});

/* Local password fallback for testing only */

app.post("/api/unlock", (req, res) => {
  if (OWNER_AUTH_REQUIRED) {
    return res.status(403).json({
      error: "Password login is disabled when Discord OAuth2 is configured."
    });
  }

  const password = String(req.body?.password || "");
  const expected = process.env.DASHBOARD_PASSWORD || "";

  if (expected.length < 8) {
    return res.status(503).json({
      error: "Configure DASHBOARD_PASSWORD or Discord OAuth2 first."
    });
  }

  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!valid) return res.status(403).json({ error: "Incorrect password." });

  req.session.localUnlocked = true;
  res.json({ ok: true, status: status() });
});

app.get("/api/status", (req, res) => {
  res.json({
    ...status(),
    locked: OWNER_AUTH_REQUIRED
      ? req.session?.discordUser?.id !== OWNER_ID
      : req.session?.localUnlocked !== true
  });
});

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

async function handleCommand(interaction) {
  if (!interaction.isChatInputCommand()) return;

  try {
    const name = interaction.commandName;

    if (name === "ping") {
      return interaction.reply({
        content: `Pong! ${client.ws.ping}ms`,
        ephemeral: true
      });
    }

    if (name === "help") {
      return interaction.reply({
        content: "/play /join /leave /pause /resume /skip /previous /stop /queue /nowplaying /volume /loop /shuffle /clear /ping /help",
        ephemeral: true
      });
    }

    if (!interaction.guild) {
      return interaction.reply({
        content: "Use this command inside a server.",
        ephemeral: true
      });
    }

    const guild = client.guilds.cache.get(interaction.guildId);
    const voice = interaction.member?.voice?.channel;
    let queue = player.nodes.get(guild.id);

    if (name === "play" || name === "join") {
      if (!voice) {
        return interaction.reply({
          content: "Join a voice channel first.",
          ephemeral: true
        });
      }

      const permissions = voice.permissionsFor(guild.members.me);
      if (!permissions?.has([
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak
      ])) {
        return interaction.reply({
          content: "I need Connect and Speak permissions.",
          ephemeral: true
        });
      }

      queue ||= createQueue(guild);
      if (!queue.connection) await queue.connect(voice);

      if (name === "join") {
        return interaction.reply({
          content: `Joined ${voice.name}.`,
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: true });
      const query = interaction.options.getString("song", true);
      const result = await player.search(query, { requestedBy: interaction.user });

      if (!result.tracks.length) return interaction.editReply("No playable results found.");

      queue.addTrack(result.tracks[0]);
      if (!queue.node.isPlaying()) await queue.node.play();

      return interaction.editReply(`Added **${result.tracks[0].title}**.`);
    }

    if (name === "leave" || name === "stop") {
      if (queue) queue.delete();
      return interaction.reply({
        content: "Playback stopped and voice disconnected.",
        ephemeral: true
      });
    }

    if (!queue) {
      return interaction.reply({
        content: "Nothing queued. Use /play first.",
        ephemeral: true
      });
    }

    switch (name) {
      case "pause":
        queue.node.setPaused(true);
        break;
      case "resume":
        queue.node.setPaused(false);
        break;
      case "skip":
        if (!queue.currentTrack) throw new Error("Nothing is playing.");
        queue.node.skip();
        break;
      case "previous":
        if (!queue.history?.previousTrack) throw new Error("No previous track.");
        await queue.history.back();
        break;
      case "queue":
        return interaction.reply({
          content: queue.tracks.size
            ? queue.tracks.toArray().slice(0, 10)
                .map((t, i) => `${i + 1}. ${t.title}`).join("\n")
            : "No upcoming tracks.",
          ephemeral: true
        });
      case "nowplaying":
        return interaction.reply({
          content: queue.currentTrack
            ? `**${queue.currentTrack.title}** — ${queue.currentTrack.author}`
            : "Nothing is playing.",
          ephemeral: true
        });
      case "volume":
        queue.node.setVolume(interaction.options.getInteger("amount", true));
        break;
      case "loop": {
        const mode = interaction.options.getString("mode", true);
        queue.setRepeatMode(({ off: 0, track: 1, queue: 2, autoplay: 3 })[mode]);
        break;
      }
      case "shuffle":
        if (!queue.tracks.size) throw new Error("Queue is empty.");
        queue.tracks.shuffle();
        break;
      case "clear":
        queue.clear();
        break;
      default:
        return interaction.reply({ content: "Unknown command.", ephemeral: true });
    }

    return interaction.reply({
      content: "Done.",
      ephemeral: true
    });
  } catch (error) {
    const message = String(error.message || error).slice(0, 1500);
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    }
    return interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
}

/* Dashboard API — owner-only */

app.use("/api", (req, res, next) => {
  if (req.path === "/status" || req.path === "/unlock") {
    return next();
  }
  return requireOwner(req, res, next);
});

app.get("/api/guilds", requireOwner, (req, res) => {
  if (!client) return res.json([]);
  res.json(client.guilds.cache.map(guild => ({
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL({ size: 128 }),
    memberCount: guild.memberCount
  })));
});

app.get("/api/guilds/:guildId/channels", requireOwner, (req, res) => {
  const guild = client?.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: "Server not found." });

  res.json(guild.channels.cache
    .filter(channel => [
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement
    ].includes(channel.type))
    .map(channel => ({
      id: channel.id,
      name: channel.name,
      type: channel.type
    })));
});

app.post("/api/bot/start", requireOwner, async (req, res) => {
  try {
    if (client?.isReady()) {
      return res.json({ ok: true, message: "Bot is already online." });
    }

    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "Enter your Discord bot token." });
    }

    if (client) {
      try { client.destroy(); } catch {}
    }

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages
      ]
    });

    player = new Player(client);

    client.once("ready", async () => {
      botReady = true;
      lastError = "";

      try {
        await client.application.commands.set(commands);
      } catch (error) {
        lastError = "Command registration failed: " + error.message;
        console.error(lastError);
      }

      client.user.setActivity("music", {
        type: ActivityType.Listening
      });
    });

    client.on("interactionCreate", handleCommand);

    client.on("error", error => {
      lastError = error.message;
      console.error("Discord client error:", error);
    });

    client.on("shardDisconnect", () => {
      botReady = false;
    });

    client.on("shardReconnecting", () => {
      botReady = false;
    });

    await client.login(token);

    res.json({
      ok: true,
      message: "Bot login started. Check the dashboard status shortly."
    });
  } catch (error) {
    botReady = false;
    lastError = error.message;
    console.error("Bot start failed:", error);
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/bot/stop", requireOwner, (req, res) => {
  if (client) {
    try { client.destroy(); } catch {}
  }

  client = null;
  player = null;
  botReady = false;

  res.json({ ok: true, message: "Bot stopped." });
});

app.post("/api/bot/activity", requireOwner, (req, res) => {
  if (!client?.user) {
    return res.status(400).json({ error: "Start the bot first." });
  }

  const text = String(req.body?.text || "music").trim().slice(0, 128);
  const type = String(req.body?.type || "Listening").toLowerCase();

  const activityTypes = {
    playing: ActivityType.Playing,
    listening: ActivityType.Listening,
    watching: ActivityType.Watching,
    competing: ActivityType.Competing
  };

  client.user.setActivity(text, {
    type: activityTypes[type] ?? ActivityType.Listening
  });

  res.json({ ok: true });
});

app.post("/api/guilds/:guildId/say", requireOwner, async (req, res) => {
  try {
    const guild = client?.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: "Server not found." });

    const channel = guild.channels.cache.get(String(req.body?.channelId || ""));
    if (!channel || !channel.isTextBased() || !channel.send) {
      return res.status(400).json({ error: "Choose a valid text channel." });
    }

    const message = String(req.body?.message || "").trim().slice(0, 1900);
    if (!message) return res.status(400).json({ error: "Message is empty." });

    await channel.send({ content: message });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/guilds/:guildId/queue", requireOwner, (req, res) => {
  const guild = client?.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: "Server not found." });

  const queue = player?.nodes.get(guild.id);

  res.json({
    current: queue?.currentTrack ? {
      title: queue.currentTrack.title,
      author: queue.currentTrack.author,
      url: queue.currentTrack.url,
      thumbnail: queue.currentTrack.thumbnail
    } : null,
    tracks: queue?.tracks.toArray().map(track => ({
      title: track.title,
      author: track.author,
      url: track.url,
      thumbnail: track.thumbnail
    })) || [],
    paused: queue?.node.isPaused() || false,
    volume: queue?.node.volume ?? 80
  });
});

/* Health check */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    botReady,
    uptime: Math.floor(process.uptime())
  });
});

/* Start server */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Musically dashboard listening on port ${PORT}`);
});
