# Musically

Discord music bot with a private web dashboard.

## Deploy on Render

1. Upload these files to your GitHub repository, keeping `public/index.html` inside the `public` folder.
2. On Render, create a **New Web Service** and connect the repository.
3. Use the Node runtime, build command `npm install`, and start command `npm start`.
4. Deploy, then open the service URL.
5. Create a dashboard password (8+ characters), unlock the dashboard, and paste the Discord bot token in the Bot connection panel.

The token is accepted by the backend and held in memory only. It is not saved in GitHub or a config file. You must enter it again after a restart/redeploy. The dashboard password is also held in memory; after a server restart, the first person to unlock the dashboard can set a new password. Keep the dashboard URL private.

## Discord setup

1. Create an application in the Discord Developer Portal and add a bot.
2. Copy its token privately. Never commit the token into any file.
3. In OAuth2 → URL Generator, select the `bot` scope and invite it to your server.
4. Grant View Channels, Connect, and Speak permissions in the voice channel.
5. The bot must be in a server for that server to appear in the dashboard.

## Notes

- Audio extraction providers can change, and not every search result or URL is guaranteed to play.
- Custom proxy routing is not implemented; the dashboard labels that option as unavailable instead of pretending it works.
- For a bot that stays online continuously, use a hosting plan that does not spin down or sleep.
- Use only music and sources you have permission to stream.
