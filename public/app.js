(() => {
  const $ = (selector) => document.querySelector(selector);
  const loginScreen = $("#loginScreen");
  const chatScreen = $("#chatScreen");
  const loginForm = $("#loginForm");
  const usernameInput = $("#username");
  const loginButton = $("#loginButton");
  const loginError = $("#loginError");
  const loginConnection = $("#loginConnection");
  const messageViewport = $("#messageViewport");
  const messageList = $("#messageList");
  function readSavedSession() {
    try {
      const username = sessionStorage.getItem("ajoe.username");
      const sessionKey = sessionStorage.getItem("ajoe.sessionKey");
      return username && sessionKey ? { username, sessionKey } : null;
    } catch {
      return null;
    }
  }

  function readSavedPendingText() {
    try {
      const value = JSON.parse(
        sessionStorage.getItem("ajoe.pendingText") || "null",
      );
      return value &&
        typeof value.requestId === "string" &&
        typeof value.roomId === "string" &&
        typeof value.sessionKey === "string" &&
        typeof value.text === "string" &&
        value.text.length <= 6000
        ? value
        : null;
    } catch {
      return null;
    }
  }

  function saveSession(username, sessionKey) {
    try {
      sessionStorage.setItem("ajoe.username", username);
      sessionStorage.setItem("ajoe.sessionKey", sessionKey);
    } catch {
      /* A private browsing window may not allow session storage. */
    }
  }

  function forgetSavedSession() {
    try {
      sessionStorage.removeItem("ajoe.username");
      sessionStorage.removeItem("ajoe.sessionKey");
    } catch {
      /* A private browsing window may not allow session storage. */
    }
  }

  const savedSession = readSavedSession();
  const savedPendingText = readSavedPendingText();
  const state = {
    socket: null,
    pendingName: savedSession?.username || null,
    username: savedSession?.username || null,
    sessionKey: savedSession?.sessionKey || null,
    channels: [],
    users: [],
    roomId: null,
    room: null,
    roomInfo: Object.create(null),
    messages: Object.create(null),
    complete: Object.create(null),
    unread: Object.create(null),
    invites: [],
    reconnecting: false,
    intentionalClose: false,
    connected: false,
    retryCount: 0,
    uploadBusy: false,
    uploadRequest: null,
    textSendBusy: false,
    pendingTextRequest: savedPendingText,
    pendingFile: null,
    pendingFileRoomId: null,
    navigationPending: false,
    renderQueued: false,
    visibleCount: 100,
  };
  if (savedSession) usernameInput.value = savedSession.username;
  const palette = [
    "#e7eadd",
    "#eee4dc",
    "#e6e8f0",
    "#eee7f2",
    "#e8ece2",
    "#f0e7e4",
  ];
  const supportedExtensions = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "avif",
    "heic",
    "heif",
    "tif",
    "tiff",
    "svg",
    "txt",
    "mp4",
    "mov",
    "doc",
    "docx",
    "pdf",
    "pptx",
    "zip",
  ]);
  const maximumBytes = 25 * 1000 * 1000;

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function connect() {
    if (
      state.socket &&
      (state.socket.readyState === WebSocket.CONNECTING ||
        state.socket.readyState === WebSocket.OPEN)
    )
      return;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    loginConnection.textContent = state.retryCount
      ? "Finding your room again"
      : "Finding your room";
    const socket = new WebSocket(`${scheme}//${location.host}/ws`);
    state.socket = socket;
    socket.addEventListener("open", () => {
      state.connected = true;
      state.retryCount = 0;
      loginConnection.textContent = "Your room is awake";
      const name = state.username || state.pendingName;
      if (state.sessionKey) sendResume();
      else if (name) sendJoin(name);
    });
    socket.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      handleEvent(data);
    });
    socket.addEventListener("close", () => {
      state.connected = false;
      if (state.socket === socket) state.socket = null;
      if (state.intentionalClose) {
        state.intentionalClose = false;
        return;
      }
      state.retryCount += 1;
      if (state.username) {
        state.reconnecting = true;
        state.room = null;
        state.roomId = null;
        state.messages = Object.create(null);
        state.roomInfo = Object.create(null);
        state.complete = Object.create(null);
        state.navigationPending = false;
        toast("Your connection paused. Returning to your room now.");
      } else {
        loginConnection.textContent = "Waiting for the room to wake";
      }
      const delay = Math.min(10000, 900 + state.retryCount * 900);
      window.setTimeout(connect, delay);
    });
    socket.addEventListener("error", () => {
      loginConnection.textContent = "Waking your room";
    });
  }

  function send(data) {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  function sendJoin(name) {
    if (!send({ type: "join", username: name })) return;
    state.pendingName = name;
    loginButton.disabled = true;
    loginButton.querySelector("span").textContent = "Opening your room";
    loginError.textContent = "";
  }

  function sendResume() {
    if (!state.sessionKey) return;
    if (!send({ type: "resume", sessionKey: state.sessionKey })) return;
    loginButton.disabled = true;
    loginButton.querySelector("span").textContent = "Returning to your room";
    loginConnection.textContent = "Returning to your room";
  }

  function clearPendingFile() {
    state.pendingFile = null;
    state.pendingFileRoomId = null;
    $("#attachmentDraft").classList.add("hidden");
    $("#attachmentName").textContent = "";
    $("#attachmentSize").textContent = "";
    updateComposer();
  }

  function clearSessionView() {
    forgetSavedSession();
    forgetSavedPendingText();
    clearPendingFile();
    state.sessionKey = null;
    state.username = null;
    state.roomId = null;
    state.room = null;
    state.channels = [];
    state.users = [];
    state.roomInfo = Object.create(null);
    state.messages = Object.create(null);
    state.complete = Object.create(null);
    state.unread = Object.create(null);
    state.invites = [];
    state.uploadBusy = false;
    state.uploadRequest = null;
    state.textSendBusy = false;
    state.pendingTextRequest = null;
    state.navigationPending = false;
  }

  function savePendingText(request) {
    state.pendingTextRequest = request;
    try {
      sessionStorage.setItem("ajoe.pendingText", JSON.stringify(request));
    } catch {
      /* A private browsing window may not allow session storage. */
    }
  }

  function forgetSavedPendingText() {
    state.pendingTextRequest = null;
    try {
      sessionStorage.removeItem("ajoe.pendingText");
    } catch {
      /* A private browsing window may not allow session storage. */
    }
  }

  function showLogin(error = "") {
    loginScreen.classList.remove("hidden");
    chatScreen.classList.add("hidden");
    loginError.textContent = error;
    loginButton.disabled = false;
    loginButton.querySelector("span").textContent = "Start chatting";
    state.pendingName = null;
    if (!state.connected) connect();
  }

  function showChat() {
    loginScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");
    $("#sidebarUsername").textContent = state.username;
    $("#userAvatar").textContent = initials(state.username);
    $("#userAvatar").style.background = avatarColor(state.username, true);
    renderChannels();
    renderPeople();
    renderIncoming();
  }

  function handleEvent(data) {
    switch (data.type) {
      case "joined": {
        const isReconnect = state.reconnecting || data.resumed;
        state.reconnecting = false;
        state.username = data.username;
        state.pendingName = null;
        state.sessionKey = data.sessionKey;
        saveSession(data.username, data.sessionKey);
        state.channels = data.channels || [];
        state.users = [];
        state.roomInfo = Object.create(null);
        state.messages = Object.create(null);
        state.complete = Object.create(null);
        state.unread = Object.create(null);
        state.invites = [];
        state.roomId = null;
        state.room = null;
        state.navigationPending = false;
        state.visibleCount = 100;
        showChat();
        if (data.resumed)
          toast("Your session is back. Your room history is ready.");
        else if (isReconnect)
          toast("You are back in the room. Public history is ready.");
        if (data.resumeRoomKind === "private" && data.resumeRoomId) {
          state.navigationPending = true;
          send({ type: "accept_dm", roomId: data.resumeRoomId });
        } else {
          enterChannel(data.resumeRoomId || data.defaultChannel || "commons");
        }
        if (state.pendingTextRequest) {
          const pending = state.pendingTextRequest;
          if (data.resumed && pending.sessionKey === data.sessionKey) {
            $("#messageInput").value = pending.text;
            $("#characterCount").textContent = `${pending.text.length} / 6000`;
            $("#messageInput").style.height = "auto";
            $("#messageInput").style.height =
              `${Math.min($("#messageInput").scrollHeight, 125)}px`;
            void sendTextRequest(pending.roomId, pending.text, data.sessionKey);
          } else {
            $("#messageInput").value = pending.text;
            $("#characterCount").textContent = `${pending.text.length} / 6000`;
            forgetSavedPendingText();
            toast("Your message was restored. Send it again when ready.", true);
          }
        }
        if (data.partnerLeft)
          toast(
            "Your conversation partner has left. Your history stays here while you stay.",
          );
        break;
      }
      case "session_replaced":
        state.intentionalClose = true;
        clearSessionView();
        state.reconnecting = false;
        showLogin(
          "This session moved to another tab. Choose a name to begin again.",
        );
        if (state.socket && state.socket.readyState < WebSocket.CLOSING)
          state.socket.close(4001, "Session resumed elsewhere");
        break;
      case "resume_failed": {
        const name = state.username || state.pendingName;
        forgetSavedSession();
        state.sessionKey = null;
        state.reconnecting = Boolean(name);
        if (name) sendJoin(name);
        else showLogin("Your room has ended. Choose a name to begin again.");
        break;
      }
      case "error": {
        const copy = data.message || "Something went wrong. Please try again.";
        if (
          data.code === "USERNAME_TAKEN" ||
          data.code === "USERNAME_INVALID"
        ) {
          state.reconnecting = false;
          clearSessionView();
          showLogin(copy);
        } else {
          state.navigationPending = false;
          renderChannels();
          renderPeople();
          updateComposer();
          toast(copy, true);
          if (!state.username && state.pendingName) {
            state.pendingName = null;
            loginButton.disabled = false;
            loginButton.querySelector("span").textContent = "Start chatting";
            loginError.textContent = copy;
          }
        }
        break;
      }
      case "presence":
        state.users = data.users || [];
        renderChannels();
        renderPeople();
        renderHeader();
        break;
      case "entered_room":
        if (state.pendingFile && state.pendingFileRoomId !== data.roomId) {
          clearPendingFile();
          toast("Your attached file was cleared after changing rooms.");
        }
        state.navigationPending = false;
        state.roomId = data.roomId;
        state.room = data.room;
        state.roomInfo[data.roomId] = data.room;
        state.unread[data.roomId] = 0;
        state.visibleCount = 100;
        state.complete[data.roomId] = false;
        state.messages[data.roomId] ||= [];
        renderChannels();
        renderPeople();
        renderHeader();
        renderMessages(false);
        updateComposer();
        messageViewport.scrollTop = messageViewport.scrollHeight;
        break;
      case "history_message":
        addMessage(data.roomId, data.message, false);
        break;
      case "history_done":
        state.complete[data.roomId] = true;
        if (data.roomId === state.roomId) {
          renderMessages(true);
          renderHeader();
        }
        break;
      case "message":
        addMessage(data.roomId, data.message, true);
        break;
      case "channel_activity":
        if (data.roomId !== state.roomId) {
          state.unread[data.roomId] = (state.unread[data.roomId] || 0) + 1;
          renderChannels();
        }
        break;
      case "dm_invite":
        state.roomInfo[data.roomId] = data.room;
        if (!state.invites.some((invite) => invite.roomId === data.roomId))
          state.invites.push({ roomId: data.roomId, name: data.from });
        renderIncoming();
        toast(`${data.from} would like to chat with you.`);
        break;
      case "private_activity":
        if (data.roomId !== state.roomId) {
          state.unread[data.roomId] = (state.unread[data.roomId] || 0) + 1;
          renderChannels();
          if (!state.invites.some((invite) => invite.roomId === data.roomId)) {
            state.invites.push({ roomId: data.roomId, name: data.from });
            renderIncoming();
          }
        }
        break;
      case "partner_left": {
        const current = state.roomInfo[data.roomId] || {};
        current.closed = true;
        current.partner = data.username || current.partner;
        state.roomInfo[data.roomId] = current;
        if (state.roomId === data.roomId) {
          state.room = current;
          renderHeader();
          updateComposer();
        }
        toast(
          `${data.username} left this chat. Your history is here while you stay.`,
        );
        if ("Notification" in window && Notification.permission === "granted") {
          try {
            new Notification(`${data.username} left the chat`, {
              body: "Your conversation is still here for this visit.",
            });
          } catch {
            /* Browser notifications can be unavailable in a private window. */
          }
        }
        break;
      }
      case "session_closed":
        clearSessionView();
        loginConnection.textContent = "Your room is ready";
        showLogin(
          data.message || "Your session has ended. Choose a name to return.",
        );
        break;
    }
  }

  function enterChannel(channelId) {
    if (state.uploadBusy || state.navigationPending) return;
    if (!send({ type: "enter_channel", channelId })) return;
    state.navigationPending = true;
    state.unread[channelId] = 0;
    renderChannels();
    updateComposer();
  }

  function initials(name) {
    const parts = String(name || "?")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "?";
    return Array.from(
      parts.length === 1
        ? parts[0].slice(0, 1)
        : parts[0][0] + parts[parts.length - 1][0],
    )
      .join("")
      .toUpperCase();
  }

  function avatarColor(name, dark = false) {
    const colors = dark
      ? ["#69758d", "#657b79", "#7f718b", "#8b766b"]
      : palette;
    let hash = 0;
    for (const char of String(name || ""))
      hash = (hash * 31 + char.codePointAt(0)) | 0;
    return colors[Math.abs(hash) % colors.length];
  }

  function renderChannels() {
    const list = $("#channelList");
    list.replaceChildren();
    for (const channel of state.channels) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `channel-button${state.roomId === channel.id ? " active" : ""}`;
      button.disabled = state.uploadBusy || state.navigationPending;
      button.setAttribute(
        "aria-current",
        state.roomId === channel.id ? "page" : "false",
      );
      const symbol = document.createElement("span");
      symbol.className = "channel-symbol";
      symbol.append(icon(channel.icon || "globe"));
      const label = document.createElement("span");
      label.className = "channel-label";
      label.textContent = channel.title;
      const peopleHere = state.users.filter(
        (person) => person.roomId === `channel:${channel.id}`,
      ).length;
      const liveCount = document.createElement("span");
      liveCount.className = "room-live-count";
      liveCount.textContent = String(peopleHere);
      liveCount.title = `${peopleHere} ${peopleHere === 1 ? "person" : "people"} here now`;
      button.setAttribute(
        "aria-label",
        `${channel.title}, ${peopleHere} ${peopleHere === 1 ? "person" : "people"} here now`,
      );
      button.append(symbol, label, liveCount);
      const unread = state.unread[channel.id] || 0;
      if (unread) {
        const pill = document.createElement("span");
        pill.className = "unread-count";
        pill.textContent = unread > 9 ? "9+" : String(unread);
        button.append(pill);
      }
      button.addEventListener("click", () => {
        closeRoomMenu();
        enterChannel(channel.id);
      });
      list.append(button);
    }
  }

  function renderPeople() {
    const list = $("#peopleList");
    list.replaceChildren();
    const others = state.users.filter(
      (person) => person.username !== state.username,
    );
    $("#onlineCount").textContent = String(others.length);
    $("#inviteEmpty").classList.toggle("hidden", others.length > 0);
    for (const person of others) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "person-button";
      button.disabled = state.uploadBusy || state.navigationPending;
      button.title = `Start a private chat with ${person.username}`;
      const avatar = document.createElement("span");
      avatar.className = "avatar person-avatar";
      avatar.textContent = initials(person.username);
      avatar.style.background = avatarColor(person.username);
      const name = document.createElement("span");
      name.className = "person-name";
      name.textContent = person.username;
      const hint = document.createElement("span");
      hint.className = "person-hint";
      hint.textContent = "Chat";
      button.append(avatar, name, hint);
      button.addEventListener("click", () => {
        closeRoomMenu();
        if (state.uploadBusy || state.navigationPending) return;
        if (!send({ type: "open_dm", username: person.username })) {
          toast("The room is reconnecting. Please try again.");
          return;
        }
        state.navigationPending = true;
        renderChannels();
        renderPeople();
        updateComposer();
      });
      list.append(button);
    }
  }

  function renderHeader() {
    if (!state.room) return;
    const isPrivate = state.room.kind === "private";
    $("#roomTitle").textContent =
      state.room.title ||
      (isPrivate
        ? `Chat with ${state.room.partner || "someone"}`
        : "The commons");
    $("#roomSubtitle").textContent =
      state.room.subtitle ||
      (isPrivate ? "A private room for two" : "A room for everything");
    $("#roomType").textContent = isPrivate ? "PRIVATE CHAT" : "PUBLIC ROOM";
    const roomIcon = $("#roomIcon");
    roomIcon.classList.toggle("private", isPrivate);
    roomIcon.replaceChildren(
      icon(isPrivate ? "chat" : state.room.icon || "globe"),
    );
    const currentChannel = state.channels.find(
      (channel) => channel.id === state.roomId,
    );
    const count = currentChannel
      ? state.users.filter(
          (person) => person.roomId === `channel:${currentChannel.id}`,
        ).length
      : 0;
    const presenceText = state.room.closed
      ? "They left this chat"
      : isPrivate
        ? "Just you two"
        : `${count} here now`;
    $("#roomPresenceText").textContent = presenceText;
    $("#roomPresence").classList.toggle("hidden", false);
    $("#emptyHint").textContent = isPrivate
      ? "A private note can be a lovely place to begin."
      : "Send the first message and see who joins in.";
    updateComposer();
  }

  function addMessage(roomId, message, live) {
    if (!message || !roomId) return;
    const messages = (state.messages[roomId] ||= []);
    if (messages.some((item) => item.id === message.id)) return;
    const wasNearBottom =
      messageViewport.scrollHeight -
        messageViewport.scrollTop -
        messageViewport.clientHeight <
      150;
    messages.push(message);
    if (live && roomId !== state.roomId) {
      state.unread[roomId] = (state.unread[roomId] || 0) + 1;
      renderChannels();
    }
    if (live && roomId !== state.roomId && String(roomId).startsWith("dm_"))
      toast(`A new note from ${message.username}.`);
    queueMessageRender(wasNearBottom && roomId === state.roomId);
  }

  function queueMessageRender(scrollBottom = false) {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      if (state.roomId) renderMessages(scrollBottom);
    });
  }

  function renderMessages(scrollBottom = false) {
    const roomId = state.roomId;
    const all = roomId ? state.messages[roomId] || [] : [];
    const start = Math.max(0, all.length - state.visibleCount);
    const visible = all.slice(start);
    const previousHeight = messageViewport.scrollHeight;
    const previousTop = messageViewport.scrollTop;
    messageList.replaceChildren();
    for (const message of visible) messageList.append(makeMessage(message));
    $("#emptyState").classList.toggle("hidden", all.length > 0);
    $("#historyTop").classList.toggle(
      "hidden",
      all.length <= state.visibleCount,
    );
    $("#olderButton").textContent = `Show earlier messages · ${start} more`;
    if (scrollBottom || (state.complete[roomId] && all.length)) {
      messageViewport.scrollTop = messageViewport.scrollHeight;
    } else if (start > 0) {
      messageViewport.scrollTop =
        previousTop + messageViewport.scrollHeight - previousHeight;
    }
  }

  function makeMessage(message) {
    const mine = message.username === state.username;
    const row = document.createElement("article");
    row.className = `message-group${mine ? " mine" : ""}`;
    const avatar = document.createElement("span");
    avatar.className = "avatar message-avatar";
    avatar.textContent = initials(message.username);
    avatar.style.background = avatarColor(message.username, mine);
    const stack = document.createElement("div");
    stack.className = "message-stack";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const sender = document.createElement("strong");
    sender.textContent = message.username;
    const time = document.createElement("time");
    time.dateTime = new Date(message.sentAt).toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(message.sentAt);
    meta.append(sender, time);
    stack.append(meta);
    if (message.kind === "file") {
      if (isPreviewableMessage(message)) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "preview-toggle";
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute(
          "aria-label",
          `Show preview for ${message.fileName}`,
        );
        toggle.append(icon("arrow"));
        const toggleLabel = document.createElement("span");
        toggleLabel.textContent = "Show preview";
        toggle.append(toggleLabel);
        const preview = document.createElement("div");
        preview.className = "media-preview hidden";
        preview.setAttribute("aria-label", `Preview of ${message.fileName}`);
        let previewLoaded = false;
        toggle.addEventListener("click", () => {
          const open = preview.classList.contains("hidden");
          preview.classList.toggle("hidden", !open);
          toggle.setAttribute("aria-expanded", String(open));
          toggle.setAttribute(
            "aria-label",
            `${open ? "Hide" : "Show"} preview for ${message.fileName}`,
          );
          toggleLabel.textContent = open ? "Hide preview" : "Show preview";
          if (open && !previewLoaded) {
            previewLoaded = true;
            const loading = document.createElement("span");
            loading.textContent = "Loading preview";
            preview.append(loading);
            void loadMediaPreview(message, preview);
          }
        });
        stack.append(toggle);
        stack.append(preview);
      }
      const file = document.createElement("div");
      file.className = "file-card";
      const glyph = document.createElement("span");
      glyph.className = "file-glyph";
      glyph.append(icon("attach"));
      const info = document.createElement("span");
      info.className = "file-info";
      const fileName = document.createElement("strong");
      fileName.textContent = message.fileName;
      fileName.title = message.fileName;
      const size = document.createElement("span");
      size.textContent = formatBytes(message.fileSize);
      info.append(fileName, size);
      const download = document.createElement("button");
      download.type = "button";
      download.className = "file-download";
      download.title = "Download the full size file";
      download.setAttribute(
        "aria-label",
        `Download full size file ${message.fileName}`,
      );
      download.append(icon("download"));
      const downloadLabel = document.createElement("span");
      downloadLabel.textContent = "Full size";
      download.append(downloadLabel);
      download.addEventListener("click", () => downloadFile(message));
      file.append(glyph, info, download);
      stack.append(file);
    } else {
      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      const fullText = String(message.text || "");
      const previewLength = 900;
      if (fullText.length > previewLength) {
        let expanded = false;
        bubble.textContent = `${fullText.slice(0, previewLength)}…`;
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "message-expand";
        toggle.setAttribute("aria-expanded", "false");
        toggle.textContent = "Show full message";
        toggle.addEventListener("click", () => {
          expanded = !expanded;
          bubble.textContent = expanded
            ? fullText
            : `${fullText.slice(0, previewLength)}…`;
          toggle.setAttribute("aria-expanded", String(expanded));
          toggle.textContent = expanded ? "Show less" : "Show full message";
        });
        stack.append(bubble, toggle);
      } else {
        bubble.textContent = fullText;
        stack.append(bubble);
      }
    }
    row.append(avatar, stack);
    return row;
  }

  function isPreviewableMessage(message) {
    const extension = String(message.fileName || "")
      .split(".")
      .pop()
      .toLowerCase();
    return (
      message.fileType?.startsWith("image/") ||
      ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"].includes(
        extension,
      ) ||
      extension === "mp4"
    );
  }

  async function loadMediaPreview(message, container) {
    let previewUrl;
    try {
      const response = await fetch(
        `/api/files/${encodeURIComponent(message.fileId)}/preview`,
        {
          method: "POST",
          headers: { "X-Session-Key": state.sessionKey },
        },
      );
      const result = await response.json();
      if (!response.ok || !result.url)
        throw new Error(result.error || "Preview unavailable");
      previewUrl = result.url;
    } catch {
      const unavailable = document.createElement("span");
      unavailable.textContent = "Preview unavailable";
      container.replaceChildren(unavailable);
      return;
    }
    const extension = String(message.fileName || "")
      .split(".")
      .pop()
      .toLowerCase();
    const isVideo = extension === "mp4" || message.fileType === "video/mp4";
    const media = document.createElement(isVideo ? "video" : "img");
    media.className = "media-preview-content";
    if (isVideo) {
      media.controls = true;
      media.playsInline = true;
      media.preload = "metadata";
    } else {
      media.alt = message.fileName;
      media.loading = "lazy";
    }
    media.src = previewUrl;
    media.addEventListener("error", () => {
      const unavailable = document.createElement("span");
      unavailable.textContent = "Preview unavailable";
      container.replaceChildren(unavailable);
    });
    container.replaceChildren(media);
  }

  function formatBytes(value) {
    if (value < 1024) return `${value} bytes`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function updateComposer() {
    const disabled =
      !state.sessionKey ||
      state.uploadBusy ||
      state.navigationPending ||
      (state.room && state.room.kind === "private" && state.room.closed);
    $("#messageInput").disabled = Boolean(disabled);
    $("#sendButton").disabled =
      Boolean(disabled) ||
      state.textSendBusy ||
      (!$("#messageInput").value.trim() && !state.pendingFile);
    $("#attachButton").disabled = Boolean(disabled);
    $("#composerBox")?.classList.toggle("disabled", Boolean(disabled));
    const notice = $("#roomNotice");
    if (state.room && state.room.kind === "private" && state.room.closed) {
      notice.textContent =
        "This chat stays here while you stay. Leave when you are ready to clear it.";
      notice.classList.remove("hidden");
    } else {
      notice.classList.add("hidden");
      notice.textContent = "";
    }
  }

  function renderIncoming() {
    const bar = $("#incomingBar");
    const invite = state.invites[0];
    if (!invite) {
      bar.classList.add("hidden");
      return;
    }
    $("#incomingTitle").textContent = `${invite.name} is here`;
    $("#incomingText").textContent = "Would you like to open a private chat?";
    bar.classList.remove("hidden");
  }

  function toast(copy, error = false) {
    const node = document.createElement("div");
    node.className = `toast${error ? " error" : ""}`;
    const label = document.createElement("span");
    label.textContent = copy;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.setAttribute("aria-label", "Close notification");
    close.addEventListener("click", () => node.remove());
    node.append(label, close);
    $("#toastStack").append(node);
    window.setTimeout(() => node.remove(), 4800);
  }

  function sendText() {
    const input = $("#messageInput");
    const text = input.value;
    if (
      !state.roomId ||
      !state.sessionKey ||
      state.uploadBusy ||
      state.textSendBusy ||
      state.navigationPending ||
      (state.room && state.room.kind === "private" && state.room.closed)
    )
      return;
    if (text.length > 6000) {
      toast("Messages can have up to 6000 characters.", true);
      return;
    }
    if (state.pendingFile) {
      if (state.pendingFileRoomId !== state.roomId) {
        clearPendingFile();
        toast("Your attached file was cleared after changing rooms.");
        return;
      }
      uploadFile(state.pendingFile, state.roomId, state.sessionKey, text);
      return;
    }
    if (!text.trim()) return;
    void sendTextRequest(state.roomId, text, state.sessionKey);
  }

  async function sendTextRequest(roomId, text, sessionKey) {
    let request = state.pendingTextRequest;
    if (
      !request ||
      request.roomId !== roomId ||
      request.text !== text ||
      request.sessionKey !== sessionKey
    ) {
      request = {
        requestId: crypto.randomUUID(),
        roomId,
        text,
        sessionKey,
      };
      savePendingText(request);
    }
    state.textSendBusy = true;
    updateComposer();
    let responseReceived = false;
    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Key": sessionKey,
          "X-Room-ID": roomId,
        },
        body: JSON.stringify({
          requestId: request.requestId,
          text,
        }),
      });
      responseReceived = true;
      let result = {};
      try {
        result = await response.json();
      } catch {
        /* The service may be waking or reconnecting. */
      }
      if (!response.ok || !result.message)
        throw new Error(result.error || "Your message could not be sent.");
      if (state.sessionKey !== sessionKey) return;
      addMessage(roomId, result.message, false);
      if (roomId === state.roomId) renderMessages(true);
      if ($("#messageInput").value === text) {
        $("#messageInput").value = "";
        $("#messageInput").style.height = "auto";
        $("#characterCount").textContent = "0 / 6000";
      }
      if (state.pendingTextRequest?.requestId === request.requestId)
        forgetSavedPendingText();
    } catch (error) {
      if (responseReceived) forgetSavedPendingText();
      if (state.sessionKey === sessionKey)
        toast(
          error.message ||
            "Your message is still here. Check your connection and try again.",
          true,
        );
    } finally {
      if (state.sessionKey === sessionKey) {
        state.textSendBusy = false;
        updateComposer();
      }
    }
  }

  function isSupportedFile(file) {
    const extension = file.name.includes(".")
      ? file.name.split(".").pop().toLowerCase()
      : "";
    return file.type.startsWith("image/") || supportedExtensions.has(extension);
  }

  function stageFile(file) {
    if (
      !file ||
      !state.sessionKey ||
      !state.roomId ||
      state.uploadBusy ||
      state.navigationPending
    )
      return;
    if (!isSupportedFile(file)) {
      toast("That file type is not supported.", true);
      return;
    }
    if (file.size >= maximumBytes) {
      toast("Choose a file smaller than 25 MB.", true);
      return;
    }
    state.pendingFile = file;
    state.pendingFileRoomId = state.roomId;
    $("#attachmentName").textContent = file.name;
    $("#attachmentSize").textContent = formatBytes(file.size);
    $("#attachmentDraft").classList.remove("hidden");
    updateComposer();
  }

  function uploadFile(file, roomId, sessionKey, text) {
    if (!file || !sessionKey || !roomId || state.uploadBusy) return;
    state.uploadBusy = true;
    updateComposer();
    $("#uploadStatus").classList.remove("hidden");
    $("#uploadStatusText").textContent = `Sending ${file.name}`;
    $("#uploadPercent").textContent = "0%";
    const xhr = new XMLHttpRequest();
    state.uploadRequest = xhr;
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("X-Session-Key", sessionKey);
    xhr.setRequestHeader("X-Room-ID", roomId);
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader(
      "X-File-Type",
      file.type || "application/octet-stream",
    );
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      $("#uploadPercent").textContent =
        `${Math.round((event.loaded / event.total) * 100)}%`;
    });
    xhr.addEventListener("load", () => {
      if (state.uploadRequest !== xhr) return;
      state.uploadBusy = false;
      state.uploadRequest = null;
      $("#uploadStatus").classList.add("hidden");
      let result = {};
      try {
        result = JSON.parse(xhr.responseText);
      } catch {
        /* The server may close a waking session. */
      }
      if (xhr.status >= 200 && xhr.status < 300 && result.message) {
        addMessage(result.roomId, result.message, false);
        if (result.roomId === state.roomId) renderMessages(true);
        clearPendingFile();
        if (text.trim() && state.sessionKey === sessionKey)
          void sendTextRequest(roomId, text, sessionKey);
      } else {
        toast(
          result.error || "Your file could not be sent. Please try again.",
          true,
        );
      }
      updateComposer();
    });
    const uploadFailed = () => {
      if (state.uploadRequest !== xhr) return;
      state.uploadBusy = false;
      state.uploadRequest = null;
      $("#uploadStatus").classList.add("hidden");
      updateComposer();
      toast("Your file could not be sent. Please try again.", true);
    };
    xhr.addEventListener("error", uploadFailed);
    xhr.addEventListener("abort", uploadFailed);
    xhr.send(file);
  }

  async function downloadFile(message) {
    try {
      const response = await fetch(
        `/api/files/${encodeURIComponent(message.fileId)}`,
        { headers: { "X-Session-Key": state.sessionKey } },
      );
      if (!response.ok) {
        let data = {};
        try {
          data = await response.json();
        } catch {
          /* Empty server response. */
        }
        throw new Error(data.error || "This file is no longer available.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = message.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) {
      toast(error.message || "This file is no longer available.", true);
    }
  }

  function logout() {
    closeRoomMenu();
    send({ type: "quit" });
    const uploadRequest = state.uploadRequest;
    state.uploadRequest = null;
    if (uploadRequest) uploadRequest.abort();
    state.intentionalClose = true;
    loginConnection.textContent = "Your room is ready";
    if (state.socket && state.socket.readyState < WebSocket.CLOSING)
      state.socket.close(1000, "Leaving");
    clearSessionView();
    state.reconnecting = false;
    showLogin("");
  }

  function setRoomMenuOpen(open) {
    chatScreen.classList.toggle("sidebar-open", open);
    $("#mobileMenuButton").setAttribute("aria-expanded", String(open));
  }

  function closeRoomMenu() {
    setRoomMenuOpen(false);
  }

  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = usernameInput.value.trim();
    if (!name) {
      loginError.textContent = "Choose a username to continue.";
      return;
    }
    if (Array.from(name).length > 24) {
      loginError.textContent = "Your username can have up to 24 characters.";
      return;
    }
    loginError.textContent = "";
    if ("Notification" in window && Notification.permission === "default") {
      try {
        Notification.requestPermission().catch(() => {});
      } catch {
        /* Notifications can be unavailable in a private window. */
      }
    }
    state.pendingName = name;
    if (state.connected) sendJoin(name);
    else {
      loginButton.disabled = true;
      loginButton.querySelector("span").textContent = "Opening your room";
      connect();
    }
  });

  $("#leaveButton").addEventListener("click", logout);
  $("#mobileLeaveButton").addEventListener("click", logout);
  $("#mobileMenuButton").addEventListener("click", () => {
    setRoomMenuOpen(!chatScreen.classList.contains("sidebar-open"));
  });
  $("#sidebarBackdrop").addEventListener("click", closeRoomMenu);
  $("#sendButton").addEventListener("click", sendText);
  $("#messageInput").addEventListener("input", (event) => {
    const input = event.currentTarget;
    $("#characterCount").textContent = `${input.value.length} / 6000`;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 125)}px`;
    updateComposer();
  });
  $("#messageInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendText();
    }
  });
  $("#attachButton").addEventListener("click", () => $("#filePicker").click());
  $("#filePicker").addEventListener("change", (event) => {
    stageFile(event.target.files && event.target.files[0]);
    event.target.value = "";
  });
  $("#removeAttachment").addEventListener("click", clearPendingFile);
  $("#olderButton").addEventListener("click", () => {
    const previousHeight = messageViewport.scrollHeight;
    const previousTop = messageViewport.scrollTop;
    state.visibleCount += 100;
    renderMessages(false);
    messageViewport.scrollTop =
      previousTop + messageViewport.scrollHeight - previousHeight;
  });
  $("#incomingOpen").addEventListener("click", () => {
    const invite = state.invites.shift();
    if (invite && send({ type: "accept_dm", roomId: invite.roomId })) {
      state.navigationPending = true;
      renderChannels();
      renderPeople();
      updateComposer();
    }
    renderIncoming();
  });
  $("#incomingDismiss").addEventListener("click", () => {
    state.invites.shift();
    renderIncoming();
  });

  connect();
  $("#composerBox")?.classList.add("composer-box");
})();
