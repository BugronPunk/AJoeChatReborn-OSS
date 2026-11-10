# AJoeChatReborn

AJoeChatReborn is a temporary chat app built with Node and browser APIs. One Node process serves the page, health check, file transfers, and WebSocket chat on one port.

The interface adapts to laptops, tablets, and phones in portrait and landscape. Every public room shows its live user count. Counts change as people join, leave, or move between rooms.

## Run locally

Use Node 20 or newer.

```sh
npm start
```

Open `http://localhost:3000`.

## Deploy on Render

The included Render service starts the app on the port provided by Render. The project has no runtime package dependencies.

The default data folder is `data`. Public messages and shared files are kept for up to twenty four hours. The app checks expiry during history requests and file downloads, then prunes stored history every five minutes.

The included service plan uses local storage. A sleeping or restarted service can lose local files before the twenty four hour period ends. To retain public history across restarts, attach a persistent disk and set `DATA_DIR` to its mount path, such as `/var/data`. Private chat records and files are removed when the last participant leaves or the service restarts.

The Render configuration limits the Node heap to 384 MB to leave room for sockets and file buffers within a 512 MB service budget. Uploads stream to disk so file bytes do not collect in server memory.

## Chat behavior

Usernames match exactly, including letter case. A name stays reserved while its session is active. Reloading the page resumes the same username, room, and history by taking over the previous connection with the saved session key. A short network interruption keeps the session available for up to fifteen seconds. The session key is kept in that browser tab. Selecting Leave ends the session and releases the username right away. If the app restarts, a saved key cannot restore an in memory session, so the person can start again if their name is free.

Public messages are shared in each room and remain available for up to twenty four hours when storage is persistent. The room member count includes the person viewing the room. Disconnected sessions are removed from live counts during the reconnect window.

Private room data belongs to the exact sessions that created it. If one person leaves, the remaining session keeps its own view and can no longer send messages in that room. The remaining person receives an in app alert and, when browser notifications are allowed, a browser notification. When the remaining person leaves, the private history and files are removed. A new session using the same username cannot reopen that conversation.

## Messages and files

Text is limited to 6000 characters. Files must be smaller than 25 MB. Supported files include images, TXT, MP4, MOV, DOC, DOCX, PDF, PPTX, and ZIP.

Text messages use an HTTP request to the same service and receive confirmation before the composer clears. If the connection fails before confirmation, the text stays in the composer and is saved in the browser tab for a quick retry after the session resumes. Recent retries use a matching request key to avoid duplicate messages. Long messages begin with a compact preview that can be opened or closed.

Choosing a file adds it to the composer. It is not sent until Send is pressed. A short message can be sent with the attached file. If the room changes before sending, the attachment is cleared to prevent posting it in the wrong room.

Images and MP4 videos have a preview that stays closed until opened. The preview can be opened or closed at any time. Videos support playback controls and seek requests. Each shared file also has a full size download option that returns its original bytes and filename.
