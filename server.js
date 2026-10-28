
/* ===== MUSICALY DASHBOARD FEATURE API =====
   Paste this block into server.js immediately
   BEFORE the existing "/* Health check */" section.
*/

const botStartedAt = Date.now();

/* Search for songs */
app.post("/api/music/search", requireOwner, async (req, res) => {
  try {
    if (!client?.isReady() || !player) {
      return res.status(400).json({ error: "Start the bot first." });
    }

    const query = String(req.body?.query || "").trim().slice(0, 300);
    if (!query) {
      return res.status(400).json({ error: "Enter a song title or artist." });
    }

    const result = await player.search(query);

    res.json({
      ok: true,
      tracks: (result.tracks || []).slice(0, 10).map(track => ({
        title: track.title,
        author: track.author,
        url: track.url,
        duration: track.duration,
        thumbnail: track.thumbnail
      }))
    });
  } catch (error) {
    console.error("Music search failed:", error.message);
    res.status(500).json({ error: "Song search failed: " + error.message });
  }
});

/* Play or queue a song from the dashboard */
app.post("/api/guilds/:guildId/play", requireOwner, async (req, res) => {
  try {
    if (!client?.isReady() || !player) {
      return res.status(400).json({ error: "Start the bot first." });
    }

    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) {
      return res.status(404).json({ error: "Server not found." });
    }

    const query = String(req.body?.query || "").trim().slice(0, 500);
    if (!query) {
      return res.status(400).json({ error: "Enter a song title or URL." });
    }

    let queue = player.nodes.get(guild.id);

    if (!queue || !queue.connection) {
      return res.status(400).json({
        error: "The bot must join a voice channel first. Use /join in Discord, then try again."
      });
    }

    const result = await player.search(query);

    if (!result.tracks?.length) {
      return res.status(404).json({ error: "No playable tracks found." });
    }

    queue.addTrack(result.tracks[0]);

    if (!queue.node.isPlaying()) {
      await queue.node.play();
    }

    res.json({
      ok: true,
      message: "Added to queue: " + result.tracks[0].title
    });
  } catch (error) {
    console.error("Dashboard play failed:", error.message);
    res.status(500).json({ error: "Could not play track: " + error.message });
  }
});

/* Playback controls */
app.post("/api/guilds/:guildId/player", requireOwner, async (req, res) => {
  try {
    if (!client?.isReady() || !player) {
      return res.status(400).json({ error: "Start the bot first." });
    }

    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) {
      return res.status(404).json({ error: "Server not found." });
    }

    const queue = player.nodes.get(guild.id);
    if (!queue) {
      return res.status(400).json({
        error: "Nothing is playing. Use /play in Discord first."
      });
    }

    const action = String(req.body?.action || "").toLowerCase();

    switch (action) {
      case "pause":
        queue.node.setPaused(true);
        break;

      case "resume":
        queue.node.setPaused(false);
        break;

      case "skip":
        if (!queue.currentTrack) {
          return res.status(400).json({ error: "Nothing is playing." });
        }
        queue.node.skip();
        break;

      case "stop":
        queue.delete();
        return res.json({ ok: true, message: "Playback stopped." });

      case "shuffle":
        if (!queue.tracks.size) {
          return res.status(400).json({ error: "The queue is empty." });
        }
        queue.tracks.shuffle();
        break;

      case "volume": {
        const volume = Number(req.body?.volume);

        if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
          return res.status(400).json({
            error: "Volume must be between 0 and 100."
          });
        }

        queue.node.setVolume(volume);
        break;
      }

      case "loop": {
        const modes = {
          off: 0,
          track: 1,
          queue: 2,
          autoplay: 3
        };

        const mode = String(req.body?.mode || "off").toLowerCase();

        if (!(mode in modes)) {
          return res.status(400).json({ error: "Invalid repeat mode." });
        }

        queue.setRepeatMode(modes[mode]);
        break;
      }

      default:
        return res.status(400).json({ error: "Unknown playback action." });
    }

    res.json({ ok: true, message: "Playback updated." });
  } catch (error) {
    console.error("Playback control failed:", error.message);
    res.status(500).json({ error: "Playback action failed: " + error.message });
  }
});

/* Improved health diagnostics */
app.get("/api/diagnostics", requireOwner, (req, res) => {
  res.json({
    ok: true,
    serverUptime: Math.floor(process.uptime()),
    botReady,
    botPing: client?.ws?.ping ?? null,
    serverCount: client?.guilds?.cache?.size ?? 0,
    musicPlayerLoaded: Boolean(player),
    lastError: lastError || null
  });
});

/* ===== END MUSICALY FEATURE API ===== */
