import { useEffect, useRef, useState } from "react";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { getDownloadURL, getStorage, ref, uploadBytes } from "firebase/storage";
import { ImagePlus, MessageCircle, Send, X } from "lucide-react";

import { app, db } from "../firebase";
import "./RoomChatBubble.css";

const CHAT_MESSAGE_LIMIT = 30;
const CHAT_TEXT_MAX = 500;
const CHAT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function chatTimeLabel(message = {}) {
  const timestampMs =
    Number(message?.createdAtMs || 0) ||
    Number(message?.createdAt?.toMillis?.() || 0);

  if (!timestampMs) return "";

  return new Date(timestampMs).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function extensionForMime(mime = "") {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "img";
}

function safeMediaFilename(file, mime) {
  const rawBase = String(file?.name || "chat-image")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return `${rawBase || "chat-image"}.${extensionForMime(mime)}`;
}

function validateChatMedia(file) {
  if (!file) return "";

  const mime = String(file.type || "").toLowerCase();
  if (mime.startsWith("video/")) {
    return "Videos are not allowed in room chat.";
  }

  if (!CHAT_ALLOWED_MIME_TYPES.has(mime)) {
    return "Choose a JPEG, PNG, WEBP, or GIF.";
  }

  if (Number(file.size || 0) > CHAT_MEDIA_MAX_BYTES) {
    return "Images and GIFs must be 10 MB or smaller.";
  }

  return "";
}

async function compressChatImage(file) {
  if (!file || file.type === "image/gif" || typeof createImageBitmap !== "function") {
    return file;
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const maxDimension = 1800;
    const scale = Math.min(
      1,
      maxDimension / Math.max(bitmap.width || 1, bitmap.height || 1)
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);

    const outputType = file.type === "image/png" ? "image/webp" : file.type;
    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, outputType, 0.82);
    });

    if (!blob || blob.size <= 0 || blob.size >= file.size) return file;

    return new File(
      [blob],
      safeMediaFilename(file, outputType),
      { type: outputType, lastModified: Date.now() }
    );
  } catch {
    return file;
  } finally {
    bitmap?.close?.();
  }
}

export default function RoomChatBubble({
  roomId,
  user,
  displayName = "",
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [selectedMedia, setSelectedMedia] = useState(null);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const unsubscribeRef = useRef(null);
  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (!selectedMedia) {
      setMediaPreviewUrl("");
      return undefined;
    }

    const objectUrl = URL.createObjectURL(selectedMedia);
    setMediaPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [selectedMedia]);

  useEffect(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;

    if (!open || !roomId || !user?.uid) {
      setMessages([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    setError("");

    const messagesQuery = query(
      collection(db, "rooms", roomId, "chatMessages"),
      orderBy("createdAtMs", "desc"),
      limit(CHAT_MESSAGE_LIMIT)
    );

    const unsubscribe = onSnapshot(
      messagesQuery,
      (snapshot) => {
        const rows = snapshot.docs
          .map((messageDoc) => ({
            id: messageDoc.id,
            ...(messageDoc.data() || {}),
          }))
          .filter((message) => message.deleted !== true)
          .reverse();

        setMessages(rows);
        setLoading(false);
      },
      (snapshotError) => {
        console.warn("[RoomChatBubble] message listener failed", snapshotError);
        setError("Chat could not load. Make sure you are still a room member.");
        setLoading(false);
      }
    );

    unsubscribeRef.current = unsubscribe;

    return () => {
      unsubscribe();
      if (unsubscribeRef.current === unsubscribe) {
        unsubscribeRef.current = null;
      }
    };
  }, [open, roomId, user?.uid]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, messages]);

  useEffect(() => {
    setOpen(false);
    setMessages([]);
    setText("");
    setSelectedMedia(null);
    setError("");
  }, [roomId]);

  if (!roomId || !user?.uid) return null;

  function closeChat() {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setOpen(false);
    setMessages([]);
    setSelectedMedia(null);
    setError("");
  }

  function chooseMedia(event) {
    const file = event.target.files?.[0] || null;
    event.target.value = "";
    if (!file) return;

    const validationError = validateChatMedia(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError("");
    setSelectedMedia(file);
  }

  function removeSelectedMedia() {
    setSelectedMedia(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function sendMessage() {
    const cleanText = text.trim();
    if (sending || (!cleanText && !selectedMedia)) return;

    setSending(true);
    setError("");

    try {
      const messageRef = doc(collection(db, "rooms", roomId, "chatMessages"));
      let mediaType = null;
      let mediaUrl = "";
      let mediaPath = "";
      let mediaMime = "";
      let mediaSize = 0;

      if (selectedMedia) {
        const validationError = validateChatMedia(selectedMedia);
        if (validationError) throw new Error(validationError);

        const uploadFile = await compressChatImage(selectedMedia);
        const compressedValidationError = validateChatMedia(uploadFile);
        if (compressedValidationError) throw new Error(compressedValidationError);

        mediaMime = String(uploadFile.type || "").toLowerCase();
        mediaType = mediaMime === "image/gif" ? "gif" : "image";
        mediaSize = Number(uploadFile.size || 0);
        const filename = safeMediaFilename(uploadFile, mediaMime);
        mediaPath = `rooms/${roomId}/chatMedia/${messageRef.id}/${filename}`;

        const mediaRef = ref(getStorage(app), mediaPath);
        await uploadBytes(mediaRef, uploadFile, {
          contentType: mediaMime,
          cacheControl: "private,max-age=3600",
        });
        mediaUrl = await getDownloadURL(mediaRef);
      }

      const nowMs = Date.now();
      await setDoc(messageRef, {
        roomId,
        uid: user.uid,
        displayName:
          String(displayName || user.displayName || user.email || "Manager")
            .trim()
            .slice(0, 120) || "Manager",
        text: cleanText.slice(0, CHAT_TEXT_MAX),
        mediaType,
        mediaUrl,
        mediaPath,
        mediaMime,
        mediaSize,
        createdAt: serverTimestamp(),
        createdAtMs: nowMs,
        deleted: false,
      });

      setText("");
      setSelectedMedia(null);
    } catch (sendError) {
      console.warn("[RoomChatBubble] send failed", sendError);
      setError(sendError?.message || "Message could not be sent.");
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(event) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent?.isComposing
    ) {
      event.preventDefault();
      sendMessage();
    }
  }

  const canSend = !sending && Boolean(text.trim() || selectedMedia);

  return (
    <div className="roomChatRoot">
      {open ? (
        <section className="roomChatPanel" aria-label="Room chat">
          <header className="roomChatHeader">
            <div>
              <strong>Room Chat</strong>
              <span>Latest 30 messages</span>
            </div>
            <button
              type="button"
              className="roomChatIconButton"
              onClick={closeChat}
              aria-label="Close room chat"
            >
              <X size={18} />
            </button>
          </header>

          <div className="roomChatMessages" aria-live="polite">
            {loading ? <div className="roomChatEmpty">Loading chat...</div> : null}
            {!loading && messages.length === 0 ? (
              <div className="roomChatEmpty">
                No messages yet. Start the room banter.
              </div>
            ) : null}

            {messages.map((message) => {
              const mine = String(message.uid || "") === String(user.uid);
              return (
                <article
                  key={message.id}
                  className={`roomChatMessage ${mine ? "roomChatMessage--mine" : ""}`}
                >
                  <div className="roomChatMessageMeta">
                    <strong>{message.displayName || "Manager"}</strong>
                    <time>{chatTimeLabel(message)}</time>
                  </div>
                  {message.text ? (
                    <div className="roomChatMessageText">{message.text}</div>
                  ) : null}
                  {message.mediaUrl ? (
                    <img
                      className="roomChatMedia"
                      src={message.mediaUrl}
                      alt={message.mediaType === "gif" ? "Shared GIF" : "Shared image"}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : null}
                </article>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          <div className="roomChatComposer">
            {mediaPreviewUrl ? (
              <div className="roomChatPreview">
                <img src={mediaPreviewUrl} alt="Selected upload preview" />
                <button
                  type="button"
                  className="roomChatPreviewRemove"
                  onClick={removeSelectedMedia}
                  aria-label="Remove selected image"
                >
                  <X size={16} />
                </button>
              </div>
            ) : null}

            {error ? <div className="roomChatError">{error}</div> : null}

            <textarea
              className="roomChatInput"
              value={text}
              onChange={(event) => setText(event.target.value.slice(0, CHAT_TEXT_MAX))}
              onKeyDown={handleComposerKeyDown}
              maxLength={CHAT_TEXT_MAX}
              rows={2}
              placeholder="Message your room..."
              disabled={sending}
            />

            <div className="roomChatComposerActions">
              <label className="roomChatAttachButton" title="Attach image or GIF">
                <ImagePlus size={18} />
                <span>Image / GIF</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={chooseMedia}
                  disabled={sending}
                />
              </label>

              <span className="roomChatCount">{text.length}/{CHAT_TEXT_MAX}</span>

              <button
                type="button"
                className="roomChatSendButton"
                onClick={sendMessage}
                disabled={!canSend}
              >
                <Send size={17} />
                <span>{sending ? "Sending..." : "Send"}</span>
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <button
        type="button"
        className={`roomChatBubble ${open ? "roomChatBubble--open" : ""}`}
        onClick={() => (open ? closeChat() : setOpen(true))}
        aria-label={open ? "Close room chat" : "Open room chat"}
        aria-expanded={open}
      >
        {open ? <X size={24} /> : <MessageCircle size={25} />}
      </button>
    </div>
  );
}
