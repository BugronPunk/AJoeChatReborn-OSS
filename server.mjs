import http from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const retentionMs = 24 * 60 * 60 * 1000;
const disconnectGraceMs = 15000;
const previewTokenLifetimeMs = 60 * 60 * 1000;
const maximumUploadBytes = 25 * 1000 * 1000;
const dataRoot = path.resolve(root, process.env.DATA_DIR || "data");
const publicData = path.join(dataRoot, "public");
const privateData = path.join(dataRoot, "private");
const uploadData = path.join(dataRoot, "uploads");
const channels = [
  {
    id: "commons",
    title: "The commons",
    subtitle: "A room for everything",
    icon: "globe",
  },
  {
    id: "afterglow",
    title: "Afterglow",
    subtitle: "Slow hours and soft thoughts",
    icon: "moon",
  },
  {
    id: "studio",
    title: "The studio",
    subtitle: "Ideas in progress",
    icon: "spark",
  },
];
const channelIds = new Set(channels.map((channel) => channel.id));
const allowedExtensions = new Set([
  "png",
  "jpg",
  "jpeg",
  "jfif",
  "gif",
  "webp",
  "bmp",
  "avif",
  "heic",
  "heif",
  "tif",
  "tiff",
  "svg",
  "ico",
  "txt",
  "mp4",
  "mov",
  "doc",
  "docx",
  "pdf",
  "pptx",
  "zip",
]);

const sessions = new Map();
const activeNames = new Map();
const privateRooms = new Map();
const publicFiles = new Map();
const privateFiles = new Map();
const previewTokens = new Map();
const fileQueues = new Map();
let isReady = false;
let maintenance = null;

function channelLog(id) {
  return path.join(publicData, `${id}.jsonl`);
}

function privateLog(id) {
  return path.join(privateData, `${id}.jsonl`);
}

function newId() {
  return randomBytes(16).toString("hex");
}

function enqueueFileWork(key, work) {
  const previous = fileQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  fileQueues.set(key, current);
  current.then(
    () => {
      if (fileQueues.get(key) === current) fileQueues.delete(key);
    },
    () => {
      if (fileQueues.get(key) === current) fileQueues.delete(key);
    },
  );
  return current;
}

function publicFileRecord(message, roomId) {
  return {
    id: message.fileId,
    roomId,
    public: true,
    name: message.fileName,
    size: message.fileSize,
    type: message.fileType || "application/octet-stream",
    sentAt: message.sentAt,
  };
}

function previewableFile(record) {
  const extension = path.extname(record.name).slice(1).toLowerCase();
  return record.type?.startsWith("image/") || extension === "mp4";
}

function fileRecordForSession(session, fileId) {
  if (!session?.online) return null;
  const record = publicFiles.get(fileId) || privateFiles.get(fileId);
  if (!record) return null;
  if (record.public && record.sentAt < Date.now() - retentionMs) return null;
  if (!record.public) {
    const room = privateRooms.get(record.roomId);
    if (!room || !room.members.has(session.key)) return null;
  }
  return record;
}

function safeFilename(input) {
  const value = String(input || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return Array.from(value || "shared file")
    .slice(0, 180)
    .join("");
}

function safeContentType(value) {
  const normalized = String(value || "").trim();
  return normalized.length < 120 &&
    /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(normalized)
    ? normalized
    : "application/octet-stream";
}

function fileContentType(filename, declaredType) {
  if (declaredType !== "application/octet-stream") return declaredType;
  const extension = path.extname(filename).slice(1).toLowerCase();
  const knownTypes = {
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    jfif: "image/jpeg",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    tif: "image/tiff",
    tiff: "image/tiff",
    webp: "image/webp",
    mp4: "video/mp4",
  };
  return knownTypes[extension] || declaredType;
}

async function compactPublicChannel(channel, cutoff) {
  const file = channelLog(channel.id);
  const temp = `${file}.tmp`;
  const keep = [];
  const writer = createWriteStream(temp, { flags: "w", mode: 0o600 });
  const done = new Promise((resolve, reject) => {
    writer.once("finish", resolve);
    writer.once("error", reject);
  });
  try {
    const input = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Number.isFinite(message.sentAt) || message.sentAt < cutoff) continue;
      if (!writer.write(`${JSON.stringify(message)}\n`))
        await once(writer, "drain");
      if (message.kind === "file" && message.fileId)
        keep.push(publicFileRecord(message, channel.id));
    }
    writer.end();
    await done;
    await rename(temp, file);
    return keep;
  } catch (error) {
    writer.destroy();
    await rm(temp, { force: true }).catch(() => {});
    if (error.code === "ENOENT") return keep;
    throw error;
  }
}

async function compactAllPublic() {
  const cutoff = Date.now() - retentionMs;
  const fresh = new Map();
  for (const channel of channels) {
    const records = await enqueueFileWork(`public:${channel.id}`, () =>
      compactPublicChannel(channel, cutoff),
    );
    for (const record of records) fresh.set(record.id, record);
  }
  for (const [id, record] of publicFiles) {
    if (record.sentAt >= cutoff) fresh.set(id, record);
  }
  for (const [id, record] of publicFiles) {
    if (record.sentAt < cutoff) publicFiles.delete(id);
  }
  for (const [id, record] of fresh) publicFiles.set(id, record);

  const files = await readdir(uploadData).catch(() => []);
  for (const name of files) {
    if (name.endsWith(".part")) continue;
    const id = name;
    if (publicFiles.has(id) || privateFiles.has(id)) continue;
    const fullPath = path.join(uploadData, name);
    const details = await stat(fullPath).catch(() => null);
    if (details && details.mtimeMs < cutoff)
      await unlink(fullPath).catch(() => {});
  }
}

async function initializeStorage() {
  await Promise.all([
    mkdir(publicData, { recursive: true }),
    mkdir(privateData, { recursive: true }),
    mkdir(uploadData, { recursive: true }),
  ]);
  for (const channel of channels) {
    const file = channelLog(channel.id);
    try {
      await open(file, "a").then((handle) => handle.close());
    } catch (error) {
      throw error;
    }
  }
  await rm(privateData, { recursive: true, force: true });
  await mkdir(privateData, { recursive: true });
  await compactAllPublic();
  const uploadFiles = await readdir(uploadData);
  for (const filename of uploadFiles) {
    if (filename.endsWith(".part")) {
      await unlink(path.join(uploadData, filename)).catch(() => {});
      continue;
    }
    if (!publicFiles.has(filename))
      await unlink(path.join(uploadData, filename)).catch(() => {});
  }
}

function frame(opcode, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let header;
  if (payload.length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function sendFrame(socket, opcode, value) {
  if (socket.destroyed || !socket.writable) return false;
  if (socket.writableLength > 1024 * 1024) {
    socket.destroy();
    return false;
  }
  return socket.write(frame(opcode, value));
}

function sendJson(socket, value) {
  if (!socket || socket.destroyed) return false;
  try {
    return sendFrame(socket, 1, JSON.stringify(value));
  } catch {
    socket.destroy();
    return false;
  }
}

async function sendJsonWait(socket, value) {
  if (!socket || socket.destroyed) return false;
  if (sendJson(socket, value)) return true;
  if (socket.destroyed) return false;
  await Promise.race([once(socket, "drain"), once(socket, "close")]);
  return !socket.destroyed;
}

function sendError(socket, code, message) {
  sendJson(socket, { type: "error", code, message });
}

function sessionForSocket(socket) {
  const session = socket.sessionKey ? sessions.get(socket.sessionKey) : null;
  return session?.online && session.socket === socket ? session : null;
}

function publicRoomView(channel) {
  return {
    kind: "public",
    title: channel.title,
    subtitle: channel.subtitle,
    icon: channel.icon,
    closed: false,
  };
}

function privateRoomView(room, sessionKey) {
  return {
    kind: "private",
    title: `Chat with ${room.partners.get(sessionKey) || "someone"}`,
    subtitle: "A private room for two",
    partner: room.partners.get(sessionKey) || "Someone",
    closed: room.closed,
  };
}

function broadcastPresence() {
  const online = [...sessions.values()].filter((session) => session.online);
  const users = online.map((session) => ({
    username: session.username,
    joinedAt: session.joinedAt,
    roomId: session.roomId,
  }));
  for (const session of online)
    sendJson(session.socket, { type: "presence", users });
}

async function sendHistory(session, publicId, roomId, file, epoch) {
  try {
    const input = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (
        !line ||
        sessions.get(session.key) !== session ||
        session.epoch !== epoch ||
        session.roomEventId !== roomId
      )
        break;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        publicId &&
        (!Number.isFinite(message.sentAt) ||
          message.sentAt < Date.now() - retentionMs)
      )
        continue;
      if (
        !(await sendJsonWait(session.socket, {
          type: "history_message",
          roomId,
          message,
        }))
      )
        break;
    }
  } catch (error) {
    if (error.code !== "ENOENT")
      console.error("Could not read a chat history:", error.message);
  }
  if (
    sessions.get(session.key) === session &&
    session.epoch === epoch &&
    session.roomEventId === roomId
  ) {
    await sendJsonWait(session.socket, { type: "history_done", roomId });
  }
}

async function enterChannel(session, channelId) {
  const channel = channels.find((item) => item.id === channelId);
  if (!channel) {
    sendError(session.socket, "ROOM_UNKNOWN", "That room is not available.");
    return;
  }
  session.roomId = `channel:${channel.id}`;
  session.roomEventId = channel.id;
  const epoch = ++session.epoch;
  broadcastPresence();
  sendJson(session.socket, {
    type: "entered_room",
    roomId: channel.id,
    room: publicRoomView(channel),
  });
  await sendHistory(
    session,
    channel.id,
    channel.id,
    channelLog(channel.id),
    epoch,
  );
}

async function enterPrivateRoom(session, room) {
  if (!room.members.has(session.key)) {
    sendError(
      session.socket,
      "ROOM_UNKNOWN",
      "That private room is no longer available.",
    );
    return;
  }
  session.roomId = room.id;
  session.roomEventId = room.id;
  const epoch = ++session.epoch;
  broadcastPresence();
  sendJson(session.socket, {
    type: "entered_room",
    roomId: room.id,
    room: privateRoomView(room, session.key),
  });
  await sendHistory(session, null, room.id, privateLog(room.id), epoch);
}

function findRoomBetween(first, second) {
  for (const room of privateRooms.values()) {
    if (
      !room.closed &&
      room.members.has(first.key) &&
      room.members.has(second.key)
    )
      return room;
  }
  return null;
}

async function openPrivateRoom(session, targetName) {
  if (targetName === session.username) {
    sendError(
      session.socket,
      "SELF_CHAT",
      "Choose another person to start a private chat.",
    );
    return;
  }
  const targetKey = activeNames.get(targetName);
  const target = targetKey ? sessions.get(targetKey) : null;
  if (!target?.online || !target.socket) {
    sendError(
      session.socket,
      "PERSON_AWAY",
      "That person is no longer online.",
    );
    return;
  }
  let room = findRoomBetween(session, target);
  if (!room) {
    const id = `dm_${newId()}`;
    room = {
      id,
      members: new Set([session.key, target.key]),
      partners: new Map([
        [session.key, target.username],
        [target.key, session.username],
      ]),
      fileIds: new Set(),
      closed: false,
    };
    privateRooms.set(id, room);
    await open(privateLog(id), "a", 0o600).then((handle) => handle.close());
    sendJson(target.socket, {
      type: "dm_invite",
      roomId: id,
      from: session.username,
      room: privateRoomView(room, target.key),
    });
  }
  await enterPrivateRoom(session, room);
}

async function acceptPrivateRoom(session, roomId) {
  const room = privateRooms.get(roomId);
  if (!room || !room.members.has(session.key)) {
    sendError(
      session.socket,
      "ROOM_UNKNOWN",
      "That private room is no longer available.",
    );
    return;
  }
  session.invites.delete(roomId);
  await enterPrivateRoom(session, room);
}

async function appendPublic(channelId, message) {
  const line = `${JSON.stringify(message)}\n`;
  await enqueueFileWork(`public:${channelId}`, () =>
    appendFile(channelLog(channelId), line, { encoding: "utf8", mode: 0o600 }),
  );
}

async function appendPrivate(room, message) {
  const line = `${JSON.stringify(message)}\n`;
  await enqueueFileWork(`private:${room.id}`, () =>
    appendFile(privateLog(room.id), line, { encoding: "utf8", mode: 0o600 }),
  );
}

async function sendTextMessage(session, request, reportError = true) {
  const result = await sendTextMessageOnce(session, request);
  if (reportError && result.error) {
    sendError(session.socket, result.error.code, result.error.message);
  }
  return result;
}

async function createTextMessage(session, request, text) {
  text = typeof text === "string" ? text : "";
  if (!session.online || sessions.get(session.key) !== session)
    return {
      error: {
        status: 401,
        code: "SESSION_INACTIVE",
        message: "Your session is no longer active.",
      },
    };
  if (!text.trim())
    return {
      error: {
        status: 400,
        code: "MESSAGE_EMPTY",
        message: "Write a message before sending it.",
      },
    };
  if (text.length > 6000) {
    return {
      error: {
        status: 413,
        code: "MESSAGE_TOO_LONG",
        message: "Messages can have up to 6000 characters.",
      },
    };
  }
  const roomId = String(request.roomId || "");
  const sentAt = Date.now();
  const message = {
    id: randomUUID(),
    kind: "text",
    username: session.username,
    text,
    sentAt,
  };
  if (channelIds.has(roomId)) {
    if (session.roomId !== `channel:${roomId}`)
      return {
        error: {
          status: 409,
          code: "ROOM_MISMATCH",
          message: "Open that public room before you send a message.",
        },
      };
    await appendPublic(roomId, message);
    for (const recipient of sessions.values()) {
      if (!recipient.online || !recipient.socket) continue;
      if (recipient.roomId === `channel:${roomId}`) {
        sendJson(recipient.socket, { type: "message", roomId, message });
      } else {
        sendJson(recipient.socket, { type: "channel_activity", roomId });
      }
    }
    return { message };
  }
  const room = privateRooms.get(roomId);
  if (
    !room ||
    room.closed ||
    room.members.size !== 2 ||
    !room.members.has(session.key) ||
    session.roomId !== roomId
  )
    return {
      error: {
        status: 409,
        code: "ROOM_CLOSED",
        message: "This private chat is no longer open.",
      },
    };
  await appendPrivate(room, message);
  if (privateRooms.get(room.id) !== room || !room.members.has(session.key))
    return {
      error: {
        status: 409,
        code: "ROOM_CLOSED",
        message: "This private chat is no longer open.",
      },
    };
  for (const key of room.members) {
    const recipient = sessions.get(key);
    if (!recipient?.online || !recipient.socket) continue;
    if (recipient.roomId === roomId)
      sendJson(recipient.socket, { type: "message", roomId, message });
    else if (recipient.key !== session.key) {
      sendJson(recipient.socket, {
        type: "private_activity",
        roomId,
        from: session.username,
      });
    }
  }
  return { message };
}

function messageRequestId(request) {
  const value = typeof request.requestId === "string" ? request.requestId : "";
  return /^[a-zA-Z0-9_-]{16,80}$/.test(value) ? value : "";
}

async function sendTextMessageOnce(session, request) {
  const text = typeof request.text === "string" ? request.text : "";
  const requestId = messageRequestId(request);
  if (!requestId) return createTextMessage(session, request, text);
  const roomId = String(request.roomId || "");
  const fingerprint = createHash("sha256")
    .update(roomId)
    .update("\0")
    .update(text)
    .digest("hex");
  const requests = session.messageRequests;
  const existing = requests.get(requestId);
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      return {
        error: {
          status: 409,
          code: "REQUEST_ID_REUSED",
          message: "That send request was already used for another message.",
        },
      };
    if (existing.pending) return existing.pending;
    return {
      message: { ...existing.message, text },
    };
  }
  const entry = { fingerprint, pending: null, message: null };
  entry.pending = createTextMessage(session, request, text)
    .then((result) => {
      entry.pending = null;
      if (result.message) {
        const metadata = { ...result.message };
        delete metadata.text;
        entry.message = metadata;
      } else if (requests.get(requestId) === entry) {
        requests.delete(requestId);
      }
      while (requests.size > 16) {
        const oldest = requests.entries().next().value;
        if (!oldest) break;
        if (oldest[1].pending) break;
        requests.delete(oldest[0]);
      }
      return result;
    })
    .catch((error) => {
      entry.pending = null;
      if (requests.get(requestId) === entry) requests.delete(requestId);
      throw error;
    });
  requests.set(requestId, entry);
  return entry.pending;
}

function broadcastFileMessage(roomId, roomKind, message, room) {
  if (roomKind === "public") {
    for (const recipient of sessions.values()) {
      if (!recipient.online || !recipient.socket) continue;
      if (recipient.roomId === `channel:${roomId}`) {
        sendJson(recipient.socket, { type: "message", roomId, message });
      } else sendJson(recipient.socket, { type: "channel_activity", roomId });
    }
    return;
  }
  for (const key of room.members) {
    const recipient = sessions.get(key);
    if (!recipient?.online || !recipient.socket) continue;
    if (recipient.roomId === roomId) {
      sendJson(recipient.socket, { type: "message", roomId, message });
    } else
      sendJson(recipient.socket, {
        type: "private_activity",
        roomId,
        from: message.username,
      });
  }
}

async function leaveSession(sessionKey) {
  const session = sessions.get(sessionKey);
  if (!session) return;
  if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
  session.disconnectTimer = null;
  session.online = false;
  if (session.socket?.sessionKey === sessionKey)
    session.socket.sessionKey = null;
  for (const [token, grant] of previewTokens) {
    if (grant.sessionKey === sessionKey) previewTokens.delete(token);
  }
  sessions.delete(sessionKey);
  if (activeNames.get(session.username) === sessionKey)
    activeNames.delete(session.username);
  session.epoch += 1;
  broadcastPresence();
  for (const room of [...privateRooms.values()]) {
    if (!room.members.has(sessionKey)) continue;
    room.members.delete(sessionKey);
    const remainingKey = room.members.values().next().value;
    if (remainingKey) {
      room.closed = true;
      const remaining = sessions.get(remainingKey);
      if (remaining?.online && remaining.socket)
        sendJson(remaining.socket, {
          type: "partner_left",
          roomId: room.id,
          username: session.username,
        });
    } else {
      privateRooms.delete(room.id);
      for (const fileId of room.fileIds) {
        privateFiles.delete(fileId);
        await unlink(path.join(uploadData, fileId)).catch(() => {});
      }
      await enqueueFileWork(`private:${room.id}`, () =>
        unlink(privateLog(room.id)).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        }),
      );
    }
  }
}

function suspendSession(sessionKey, socket) {
  const session = sessions.get(sessionKey);
  if (!session || session.socket !== socket) return;
  session.online = false;
  session.socket = null;
  session.epoch += 1;
  socket.sessionKey = null;
  broadcastPresence();
  session.disconnectTimer = setTimeout(() => {
    if (sessions.get(sessionKey) === session && !session.online)
      void leaveSession(sessionKey);
  }, disconnectGraceMs);
  session.disconnectTimer.unref();
}

function validateSessionRoom(session, roomId) {
  if (!session?.online) return null;
  if (channelIds.has(roomId)) {
    if (session.roomId !== `channel:${roomId}`) return null;
    return { kind: "public", channelId: roomId, room: null };
  }
  const room = privateRooms.get(roomId);
  if (
    !room ||
    room.closed ||
    room.members.size !== 2 ||
    !room.members.has(session.key) ||
    session.roomId !== roomId
  )
    return null;
  return { kind: "private", roomId, room };
}

function sendHttpJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readJsonBody(request, maximumBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("The request body is invalid.");
    return value;
  } catch {
    const error = new Error("The request body could not be read.");
    error.statusCode = 400;
    throw error;
  }
}

async function handleTextMessageRequest(request, response) {
  const session = sessions.get(String(request.headers["x-session-key"] || ""));
  if (!session?.online) {
    request.resume();
    sendHttpJson(response, 401, {
      error: "Your session is no longer active.",
    });
    return;
  }
  const contentType = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    request.resume();
    sendHttpJson(response, 415, {
      error: "The message format is not supported.",
    });
    return;
  }
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendHttpJson(response, error.statusCode || 400, {
      error: error.message || "The message could not be read.",
    });
    return;
  }
  const requestId = messageRequestId(body);
  if (!requestId) {
    sendHttpJson(response, 400, { error: "The message request is invalid." });
    return;
  }
  const roomId = String(request.headers["x-room-id"] || "");
  try {
    const result = await sendTextMessage(
      session,
      { roomId, text: body.text, requestId },
      false,
    );
    if (result.error) {
      sendHttpJson(response, result.error.status, {
        error: result.error.message,
        code: result.error.code,
      });
      return;
    }
    sendHttpJson(response, 200, { message: result.message });
  } catch (error) {
    console.error("A chat action could not be completed:", error.message);
    sendHttpJson(response, 500, {
      error:
        "That message could not be saved. Your text is still available to retry.",
    });
  }
}

function uploadResponseHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

async function handleUpload(request, response) {
  const key = String(request.headers["x-session-key"] || "");
  const session = sessions.get(key);
  const roomId = String(request.headers["x-room-id"] || "");
  const access = session && validateSessionRoom(session, roomId);
  if (!session || !access) {
    sendHttpJson(response, 401, { error: "Your session is no longer active." });
    request.resume();
    return;
  }
  let filename;
  try {
    filename = safeFilename(
      decodeURIComponent(String(request.headers["x-file-name"] || "")),
    );
  } catch {
    sendHttpJson(response, 400, { error: "Choose a file with a valid name." });
    request.resume();
    return;
  }
  const extension = path.extname(filename).slice(1).toLowerCase();
  const declaredType = fileContentType(
    filename,
    safeContentType(request.headers["x-file-type"]),
  );
  if (!allowedExtensions.has(extension) && !declaredType.startsWith("image/")) {
    sendHttpJson(response, 415, { error: "That file type is not supported." });
    request.resume();
    return;
  }
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength >= maximumUploadBytes) {
    sendHttpJson(response, 413, { error: "Choose a file smaller than 25 MB." });
    request.resume();
    return;
  }
  const id = newId();
  const temporaryPath = path.join(uploadData, `${id}.part`);
  const finalPath = path.join(uploadData, id);
  const output = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
  let byteCount = 0;
  let rejected = false;
  let handledError = false;
  let resolveFinished;
  let rejectFinished;
  const outputFinished = new Promise((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  output.once("finish", resolveFinished);
  output.once("error", (error) => {
    rejectFinished(error);
    if (handledError || response.writableEnded) return;
    handledError = true;
    rejected = true;
    request.resume();
    sendHttpJson(response, 500, {
      error: "The file could not be saved. Please try again.",
    });
    void unlink(temporaryPath).catch(() => {});
  });
  request.on("data", (chunk) => {
    if (rejected) return;
    byteCount += chunk.length;
    if (byteCount >= maximumUploadBytes) {
      rejected = true;
      request.pause();
      output.destroy();
      sendHttpJson(response, 413, {
        error: "Choose a file smaller than 25 MB.",
      });
      request.resume();
      void unlink(temporaryPath).catch(() => {});
      return;
    }
    if (!output.write(chunk)) {
      request.pause();
      output.once("drain", () => request.resume());
    }
  });
  request.once("aborted", () => {
    rejected = true;
    output.destroy();
    void unlink(temporaryPath).catch(() => {});
  });
  request.once("error", () => {
    rejected = true;
    output.destroy();
    void unlink(temporaryPath).catch(() => {});
  });
  request.once("end", async () => {
    if (rejected) return;
    if (!byteCount) {
      rejected = true;
      output.end();
      sendHttpJson(response, 400, {
        error: "Choose a file with some content.",
      });
      void unlink(temporaryPath).catch(() => {});
      return;
    }
    output.end();
    try {
      await outputFinished;
      const currentAccess = validateSessionRoom(session, roomId);
      if (
        sessions.get(session.key) !== session ||
        !currentAccess ||
        currentAccess.kind !== access.kind ||
        currentAccess.channelId !== access.channelId ||
        currentAccess.room !== access.room
      ) {
        rejected = true;
        await unlink(temporaryPath).catch(() => {});
        sendHttpJson(response, 401, {
          error: "Your session has changed. Please choose the file again.",
        });
        return;
      }
      await rename(temporaryPath, finalPath);
      const sentAt = Date.now();
      const message = {
        id: randomUUID(),
        kind: "file",
        username: session.username,
        fileId: id,
        fileName: filename,
        fileSize: byteCount,
        fileType: declaredType,
        sentAt,
      };
      if (access.kind === "public") {
        await appendPublic(access.channelId, message);
        publicFiles.set(id, publicFileRecord(message, access.channelId));
      } else {
        await appendPrivate(access.room, message);
        if (
          privateRooms.get(access.room.id) !== access.room ||
          access.room.closed
        ) {
          await unlink(finalPath).catch(() => {});
          sendHttpJson(response, 409, {
            error: "The private room has closed.",
          });
          return;
        }
        access.room.fileIds.add(id);
        privateFiles.set(id, {
          id,
          roomId: access.room.id,
          public: false,
          name: filename,
          size: byteCount,
          type: message.fileType,
          sentAt,
        });
      }
      broadcastFileMessage(roomId, access.kind, message, access.room);
      uploadResponseHeaders(response);
      sendHttpJson(response, 201, { roomId, message });
    } catch (error) {
      console.error("Could not finish a file upload:", error.message);
      await unlink(temporaryPath).catch(() => {});
      await unlink(finalPath).catch(() => {});
      if (!response.writableEnded)
        sendHttpJson(response, 500, {
          error: "The file could not be sent. Please try again.",
        });
    }
  });
}

function encodedFilename(name) {
  const fallback =
    String(name)
      .replace(/["\\\r\n]/g, "_")
      .replace(/[^\x20-\x7e]/g, "_") || "shared file";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function handleDownload(request, response, fileId) {
  const key = String(request.headers["x-session-key"] || "");
  const session = sessions.get(key);
  if (!session?.online) {
    sendHttpJson(response, 401, { error: "Your session is no longer active." });
    return;
  }
  const record = fileRecordForSession(session, fileId);
  if (!record) {
    sendHttpJson(response, 404, { error: "This file is no longer available." });
    return;
  }
  const filePath = path.join(uploadData, fileId);
  const details = await stat(filePath).catch(() => null);
  if (!details || !details.isFile()) {
    sendHttpJson(response, 404, { error: "This file is no longer available." });
    return;
  }
  if (request.method === "HEAD") {
    response.writeHead(200, {
      "Content-Type": record.type || "application/octet-stream",
      "Content-Length": details.size,
      "Content-Disposition": encodedFilename(record.name),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": record.type || "application/octet-stream",
    "Content-Length": details.size,
    "Content-Disposition": encodedFilename(record.name),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(response);
}

function createPreviewUrlForSession(session, fileId) {
  const record = fileRecordForSession(session, fileId);
  if (!record || !previewableFile(record)) return null;
  const now = Date.now();
  for (const [token, grant] of previewTokens) {
    if (grant.expiresAt <= now) previewTokens.delete(token);
  }
  while (previewTokens.size >= 2048)
    previewTokens.delete(previewTokens.keys().next().value);
  const token = randomBytes(24).toString("base64url");
  previewTokens.set(token, {
    fileId,
    sessionKey: session.key,
    expiresAt: now + previewTokenLifetimeMs,
  });
  return `/api/preview/${fileId}?token=${encodeURIComponent(token)}`;
}

function issuePreviewUrl(request, response, fileId) {
  const key = String(request.headers["x-session-key"] || "");
  const session = sessions.get(key);
  const url = createPreviewUrlForSession(session, fileId);
  if (!url) {
    sendHttpJson(response, 404, { error: "This preview is not available." });
    return;
  }
  sendHttpJson(response, 200, {
    url,
  });
}

async function handlePreview(request, response, fileId, token) {
  const grant = previewTokens.get(token);
  if (!grant || grant.fileId !== fileId || grant.expiresAt <= Date.now()) {
    if (grant) previewTokens.delete(token);
    sendHttpJson(response, 404, {
      error: "This preview is no longer available.",
    });
    return;
  }
  const session = sessions.get(grant.sessionKey);
  const record = fileRecordForSession(session, fileId);
  if (!record || !previewableFile(record)) {
    previewTokens.delete(token);
    sendHttpJson(response, 404, {
      error: "This preview is no longer available.",
    });
    return;
  }
  const filePath = path.join(uploadData, fileId);
  const details = await stat(filePath).catch(() => null);
  if (!details || !details.isFile()) {
    sendHttpJson(response, 404, {
      error: "This preview is no longer available.",
    });
    return;
  }
  let start = 0;
  let end = details.size - 1;
  let status = 200;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (!match || (!match[1] && !match[2])) {
      response.writeHead(416, { "Content-Range": `bytes */${details.size}` });
      response.end();
      return;
    }
    if (!match[1]) {
      const suffix = Number(match[2]);
      start = Math.max(0, details.size - suffix);
    } else {
      start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
    }
    if (start >= details.size || end < start) {
      response.writeHead(416, { "Content-Range": `bytes */${details.size}` });
      response.end();
      return;
    }
    end = Math.min(end, details.size - 1);
    status = 206;
  }
  const headers = {
    "Content-Type": record.type || "application/octet-stream",
    "Content-Length": end - start + 1,
    "Content-Disposition": encodedFilename(record.name).replace(
      /^attachment;/,
      "inline;",
    ),
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none';",
  };
  if (status === 206)
    headers["Content-Range"] = `bytes ${start}-${end}/${details.size}`;
  response.writeHead(status, headers);
  createReadStream(filePath, { start, end }).pipe(response);
}

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);

const server = http.createServer(async (request, response) => {
  const url = new URL(
    request.url || "/",
    `http://${request.headers.host || "localhost"}`,
  );
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendHttpJson(response, isReady ? 200 : 503, { ready: isReady });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/messages") {
    await handleTextMessageRequest(request, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/upload") {
    await handleUpload(request, response);
    return;
  }
  const fileMatch = url.pathname.match(/^\/api\/files\/([a-f0-9]{32})$/);
  if ((request.method === "GET" || request.method === "HEAD") && fileMatch) {
    await handleDownload(request, response, fileMatch[1]);
    return;
  }
  const previewIssueMatch = url.pathname.match(
    /^\/api\/files\/([a-f0-9]{32})\/preview$/,
  );
  if (request.method === "POST" && previewIssueMatch) {
    issuePreviewUrl(request, response, previewIssueMatch[1]);
    return;
  }
  const previewMatch = url.pathname.match(/^\/api\/preview\/([a-f0-9]{32})$/);
  if (request.method === "GET" && previewMatch) {
    await handlePreview(
      request,
      response,
      previewMatch[1],
      String(url.searchParams.get("token") || ""),
    );
    return;
  }
  const asset = staticFiles.get(url.pathname);
  if ((request.method === "GET" || request.method === "HEAD") && asset) {
    const assetPath = path.join(root, "public", asset[0]);
    const body = await readFile(assetPath).catch(() => null);
    if (!body) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": asset[1],
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  response.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end("Not found");
});

function closeSocket(socket, code = 1000, reason = "") {
  if (socket.destroyed || !socket.writable) return;
  const message = Buffer.alloc(2 + Buffer.byteLength(reason));
  message.writeUInt16BE(code, 0);
  message.write(reason, 2);
  sendFrame(socket, 8, message);
  socket.end();
}

function acceptWebSocket(request, socket) {
  const key = request.headers["sec-websocket-key"];
  if (!key || request.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.host) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
  }
  const digest = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${digest}`,
      "\r\n",
    ].join("\r\n"),
  );
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);
  socket.setTimeout(0);
  socket.sessionKey = null;
  socket.frameBuffer = Buffer.alloc(0);
  socket.on("data", (chunk) => receiveFrames(socket, chunk));
  socket.on("close", () => {
    if (socket.sessionKey) suspendSession(socket.sessionKey, socket);
  });
  socket.on("error", () => {
    if (socket.sessionKey) suspendSession(socket.sessionKey, socket);
  });
}

async function handleSocketMessage(socket, text) {
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    sendError(socket, "BAD_MESSAGE", "That message could not be read.");
    return;
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) return;
  if (request.type === "resume") {
    if (sessionForSocket(socket)) {
      sendError(socket, "ALREADY_JOINED", "You are already in this room.");
      return;
    }
    const key =
      typeof request.sessionKey === "string" ? request.sessionKey : "";
    const candidate = sessions.get(key);
    if (!candidate) {
      sendJson(socket, { type: "resume_failed" });
      return;
    }
    if (candidate.socket && candidate.socket !== socket) {
      sendJson(candidate.socket, { type: "session_replaced" });
      candidate.socket.sessionKey = null;
      closeSocket(candidate.socket, 4001, "Session resumed elsewhere");
    }
    if (candidate.disconnectTimer) clearTimeout(candidate.disconnectTimer);
    candidate.disconnectTimer = null;
    candidate.socket = socket;
    candidate.online = true;
    socket.sessionKey = candidate.key;
    const isPrivate = candidate.roomId?.startsWith("dm_");
    const publicRoomId = candidate.roomId?.startsWith("channel:")
      ? candidate.roomId.slice("channel:".length)
      : null;
    sendJson(socket, {
      type: "joined",
      username: candidate.username,
      sessionKey: candidate.key,
      channels,
      defaultChannel: publicRoomId || "commons",
      resumed: true,
      resumeRoomId: isPrivate ? candidate.roomId : publicRoomId,
      resumeRoomKind: isPrivate ? "private" : "public",
      partnerLeft: isPrivate && privateRooms.get(candidate.roomId)?.closed,
    });
    broadcastPresence();
    return;
  }
  const session = sessionForSocket(socket);
  if (request.type === "join") {
    if (session) {
      sendError(socket, "ALREADY_JOINED", "You are already in this room.");
      return;
    }
    const username =
      typeof request.username === "string" ? request.username.trim() : "";
    if (
      !username ||
      Array.from(username).length > 24 ||
      /[\u0000-\u001f\u007f]/.test(username)
    ) {
      sendError(
        socket,
        "USERNAME_INVALID",
        "Choose a username with 1 to 24 characters.",
      );
      return;
    }
    if (activeNames.has(username)) {
      sendError(
        socket,
        "USERNAME_TAKEN",
        "That username is already in use. Try another name.",
      );
      return;
    }
    const key = randomBytes(24).toString("base64url");
    const newSession = {
      key,
      username,
      socket,
      online: true,
      disconnectTimer: null,
      joinedAt: Date.now(),
      roomId: null,
      roomEventId: null,
      epoch: 0,
      invites: new Set(),
      messageRequests: new Map(),
    };
    sessions.set(key, newSession);
    activeNames.set(username, key);
    socket.sessionKey = key;
    sendJson(socket, {
      type: "joined",
      username,
      sessionKey: key,
      channels,
      defaultChannel: "commons",
    });
    broadcastPresence();
    return;
  }
  if (!session) {
    sendError(socket, "NOT_JOINED", "Choose a username before you begin.");
    return;
  }
  try {
    if (request.type === "enter_channel")
      await enterChannel(session, String(request.channelId || ""));
    else if (request.type === "open_dm")
      await openPrivateRoom(
        session,
        typeof request.username === "string" ? request.username : "",
      );
    else if (request.type === "accept_dm")
      await acceptPrivateRoom(session, String(request.roomId || ""));
    else if (request.type === "send_text")
      await sendTextMessage(session, request);
    else if (request.type === "quit") {
      sendJson(socket, {
        type: "session_closed",
        message: "You have left the room. Choose a name to return.",
      });
      await leaveSession(session.key);
      socket.sessionKey = null;
      closeSocket(socket);
    }
  } catch (error) {
    console.error("A chat action could not be completed:", error.message);
    sendError(
      socket,
      "ACTION_FAILED",
      "That action could not be completed. Please try again.",
    );
  }
}

function receiveFrames(socket, chunk) {
  socket.frameBuffer = Buffer.concat([socket.frameBuffer, chunk]);
  if (socket.frameBuffer.length > 1024 * 1024) {
    closeSocket(socket, 1009, "Message too large");
    return;
  }
  while (socket.frameBuffer.length >= 2) {
    const buffer = socket.frameBuffer;
    const first = buffer[0];
    const second = buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if ((first & 0x70) !== 0 || (first & 0x80) === 0 || !masked) {
      closeSocket(socket, 1002, "Invalid frame");
      return;
    }
    if (length === 126) {
      if (buffer.length < 4) return;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return;
      const wideLength = buffer.readBigUInt64BE(2);
      if (wideLength > 65536n) {
        closeSocket(socket, 1009, "Message too large");
        return;
      }
      length = Number(wideLength);
      offset = 10;
    }
    if (length > 65536) {
      closeSocket(socket, 1009, "Message too large");
      return;
    }
    if (buffer.length < offset + 4 + length) return;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(
      buffer.subarray(offset + 4, offset + 4 + length),
    );
    for (let index = 0; index < payload.length; index += 1)
      payload[index] ^= mask[index & 3];
    socket.frameBuffer = buffer.subarray(offset + 4 + length);
    if (opcode === 8) {
      closeSocket(socket);
      return;
    }
    if (opcode === 9) {
      sendFrame(socket, 10, payload);
      continue;
    }
    if (opcode === 10) continue;
    if (opcode !== 1) {
      closeSocket(socket, 1003, "Text messages only");
      return;
    }
    void handleSocketMessage(socket, payload.toString("utf8"));
  }
}

server.on("upgrade", (request, socket) => {
  const url = new URL(
    request.url || "/",
    `http://${request.headers.host || "localhost"}`,
  );
  if (
    url.pathname !== "/ws" ||
    request.headers.upgrade?.toLowerCase() !== "websocket"
  ) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  acceptWebSocket(request, socket);
});

server.headersTimeout = 15000;
server.requestTimeout = 0;
server.keepAliveTimeout = 5000;

async function start() {
  await initializeStorage();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  isReady = true;
  console.log(`AJoeChatReborn is listening on port ${port}`);
  const heartbeat = setInterval(() => {
    for (const session of sessions.values()) {
      if (!session.online || !session.socket) continue;
      sendFrame(session.socket, 9, randomBytes(4));
    }
  }, 25000);
  heartbeat.unref();
  const timer = setInterval(
    () => {
      if (!maintenance)
        maintenance = compactAllPublic()
          .catch((error) =>
            console.error("History cleanup failed:", error.message),
          )
          .finally(() => {
            maintenance = null;
          });
    },
    5 * 60 * 1000,
  );
  timer.unref();
}

async function shutdown() {
  isReady = false;
  for (const session of [...sessions.values()]) {
    if (session.online && session.socket) {
      sendJson(session.socket, {
        type: "session_closed",
        message:
          "The room is closing for a moment. Choose a name when it returns.",
      });
      session.socket.end();
    }
    await leaveSession(session.key);
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(privateData, { recursive: true, force: true }).catch(() => {});
}

process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

start().catch((error) => {
  console.error("The chat server could not start:", error);
  process.exit(1);
});
