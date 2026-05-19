// web/src/pages/Profile.jsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  auth,
  db,
  saveDisplayName,
  watchUserProfile,
  getRememberMe,
  setRememberMe,
  signOutNow,
  uploadUserAvatar,
  setLastRoomId,
} from "../firebase";
import { onAuthStateChanged } from "firebase/auth";
import {
  doc,
  getDoc,
  onSnapshot,
  collection, 
  query,
  orderBy,
  setDoc,
  serverTimestamp,
  deleteDoc,
} from "firebase/firestore";
import { Avatar, AvatarImage, AvatarFallback } from "../components/ui/avatar";
import "./Profile.css";

function getRoomCompetitionLabel(r = {}) {
  return (
    r.competitionMeta?.name ||
    r.competitionMeta?.label ||
    r.competitionName ||
    r.competition?.name ||
    r.competition?.label ||
    r.leagueName ||
    r.league?.name ||
    r.cupName ||
    r.tournamentName ||
    r.competitionLabel ||
    (r.worldCupMode || r.engineType === "worldCupDaily" ? "World Cup" : "") ||
    "Competition not set"
  );
}

export default function Profile() {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);

  const [name, setName] = useState("");
  const [remember, setRemember] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedPref, setSavedPref] = useState(false);

  const nav = useNavigate();

  // Avatar
  const [avatarFile, setAvatarFile] = useState(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState("");

  // Rooms list
  const [roomIdsByUidField, setRoomIdsByUidField] = useState([]);
  const [roomIdsByDocId, setRoomIdsByDocId] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState("");
  const [deletingRoomId, setDeletingRoomId] = useState("");

  // watch auth user
  useEffect(() => onAuthStateChanged(auth, setUser), []);

  // watch profile doc
  useEffect(() => {
    if (!user?.uid) return;
    const unsub = watchUserProfile(user.uid, (p) => {
      setProfile(p);
      if (p?.displayName) setName(p.displayName);
    });
    return unsub;
  }, [user?.uid]);

  // load remember-me pref
  useEffect(() => {
    setRemember(getRememberMe());
  }, []);

  async function onSaveDisplayName(e) {
    e.preventDefault();
    if (!user?.uid) return;
    const displayName = name.trim();
    if (!displayName) return;

    setSaving(true);
    try {
      await saveDisplayName(user.uid, displayName);
      nav("/draft");
    } finally {
      setSaving(false);
    }
  }

  function onSaveRemember() {
    setRememberMe(remember);
    setSavedPref(true);
    setTimeout(() => setSavedPref(false), 2000);
  }

  async function applyRememberNow() {
    await signOutNow();
  }

  async function handleUploadAvatar() {
    if (!user?.uid || !avatarFile) return;

    setAvatarUploading(true);
    setAvatarMsg("");
    try {
      await uploadUserAvatar(user.uid, avatarFile);
      setAvatarFile(null);
      setAvatarMsg("✅ Profile picture updated!");
    } catch (e) {
      setAvatarMsg(`❌ ${e?.message || "Upload failed"}`);
    } finally {
      setAvatarUploading(false);
    }
  }

  // --- Rooms membership watchers ---
  // We listen in 2 ways so it works for BOTH:
  // - old member docs (no uid field) => match by documentId == uid
  // - new member docs (with uid field) => match by uid field
  useEffect(() => {
    if (!user?.uid) return;

    setRoomsLoading(true);
    setRoomsError("");

    const q = query(
      collection(db, "users", user.uid, "rooms"),
      orderBy("lastSeenAt", "desc")
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const ids = snap.docs
          .map((d) => {
            const data = d.data() || {};
            return String(data.roomId || d.id || "").trim();
          })
          .filter(Boolean);

        setRoomIdsByDocId(ids);
        setRoomsLoading(false);
      },
      (err) => {
        setRoomsError(err?.message || "Failed to load rooms");
        setRoomsLoading(false);
      }
    );

    return unsub;
  }, [user?.uid]);


  const joinedRoomIds = useMemo(() => {
    const s = new Set([...(roomIdsByUidField || []), ...(roomIdsByDocId || [])]);
    return Array.from(s);
  }, [roomIdsByUidField, roomIdsByDocId]);

  // Fetch room docs for display (code + name + info)
  useEffect(() => {
    if (!user?.uid) return;

    let cancelled = false;

    async function loadRooms() {
      setRoomsError("");
      setRoomsLoading(true);

      try {
        if (!joinedRoomIds.length) {
          if (!cancelled) setRooms([]);
          return;
        }

        const docs = await Promise.all(
          joinedRoomIds.map(async (id) => {
            const snap = await getDoc(doc(db, "rooms", id));
            if (!snap.exists()) {
              return { id, code: id, name: "(missing room)", missing: true };
            }
            const r = snap.data();

            const updatedAt =
              typeof r.updatedAt?.toMillis === "function"
                ? r.updatedAt.toMillis()
                : r.updatedAt || 0;

            return {
              id,
              code: r.code || id,
              name: r.name || "Room",
              competitionLabel: getRoomCompetitionLabel(r),
              hostUid: r.hostUid || "",
              membersCount: Array.isArray(r.members) ? r.members.length : null,
              started: !!r.started,
              startAt: r.startAt || null,
              updatedAt,
            };
          })
        );

        docs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        if (!cancelled) setRooms(docs);
      } catch (e) {
        if (!cancelled) setRoomsError(e?.message || "Failed to load rooms");
      } finally {
        if (!cancelled) setRoomsLoading(false);
      }
    }

    loadRooms();
    return () => {
      cancelled = true;
    };
  }, [user?.uid, joinedRoomIds]);


  useEffect(() => {
    if (!user?.uid) return;
    if (!rooms?.length) return;

    const unsubs = [];

    rooms.forEach((r) => {
      const roomId = r.roomId || r.id;
      if (!roomId) return;

      const unsub = onSnapshot(doc(db, "rooms", roomId), (snap) => {
        if (!snap.exists()) return;

        const data = snap.data();
        setRooms((prev) =>
          prev.map((x) => {
            const xid = x.roomId || x.id;
            if (xid !== roomId) return x;

            return {
              ...x,
              // always show freshest name + code + started
              name: data.name || x.name,
              code: data.code || x.code,
              competitionLabel: getRoomCompetitionLabel(data) || x.competitionLabel,
              started: !!data.started,
              hostUid: data.hostUid || x.hostUid,
              updatedAt:
                typeof data.updatedAt?.toMillis === "function"
                  ? data.updatedAt.toMillis()
                  : data.updatedAt || x.updatedAt,
            };
          })
        );
      });

      unsubs.push(unsub);
    });

    return () => unsubs.forEach((fn) => fn());
  }, [user?.uid, rooms.map(r => r.roomId || r.id).join("|")]);


  async function openRoom(roomId) {
    // Saves “last room” and deep-links Draft to that room
    setLastRoomId(roomId);

    await setDoc(
      doc(db, "users", user.uid, "rooms", roomId),
      { lastSeenAt: serverTimestamp() },
      { merge: true}
    );

    nav(`/draft?room=${roomId}`);
  }

  async function deleteRoomFromMyList(roomId, roomName) {
    if (!user?.uid || !roomId) return;

    const ok = window.confirm(
      `Remove "${roomName || roomId}" from your rooms list?\n\nThis only removes it from YOUR list. It does not delete the room for other people.`
    );
    if (!ok) return;

    setDeletingRoomId(roomId);
    try {
      // delete membership/history doc under the user
      await deleteDoc(doc(db, "users", user.uid, "rooms", roomId));

      // optional: optimistic UI update (snapshot will also handle it)
      setRooms((prev) => prev.filter((r) => r.id !== roomId && (r.roomId || r.id) !== roomId));
    } catch (e) {
      alert(e?.message || "Failed to delete room from your list");
    } finally {
      setDeletingRoomId("");
    }
  }

  if (!user) {
    return (
      <div className="profilePage">
        <div className="profileWrap">
          <div className="profileCard">
            <h1 className="profileTitle">Please sign in first</h1>
            <p className="profileSub">Then come back to set your profile.</p>
            <button className="profileBtn profileBtnPrimary" onClick={() => nav("/signin")}>
              Go to Sign In
            </button>
          </div>
        </div>
      </div>
    );
  }

  const showName = profile?.displayName || user.email || "User";

  return (
    <div className="profilePage">
      <div className="profileWrap">
        {/* Display Name */}
        <form onSubmit={onSaveDisplayName} className="profileCard">
          <h1 className="profileTitle">Choose your Display name</h1>
          <p className="profileSub">Other users will see this name.</p>

          <input
            className="profileInput"
            placeholder="e.g. User"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={30}
            required
          />

          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="profileBtn profileBtnPrimary profileBtnBlock"
          >
            {saving ? "Saving..." : "Save & Continue"}
          </button>
        </form>

        {/* Profile Picture */}
        <section className="profileCard">
          <h2 className="profileTitle">Profile Picture</h2>

          <div className="avatarRow">
            <Avatar className="h-16 w-16">
              <AvatarImage src={profile?.photoURL || ""} alt="Profile picture" />
              <AvatarFallback>
                {showName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>

            <div className="avatarControls">
              <input
                className="profileFile"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => setAvatarFile(e.target.files?.[0] || null)}
              />

              <button
                type="button"
                className="profileBtn profileBtnPrimary"
                onClick={handleUploadAvatar}
                disabled={!avatarFile || avatarUploading}
              >
                {avatarUploading ? "Uploading..." : "Upload"}
              </button>

              {avatarMsg ? <div>{avatarMsg}</div> : null}
              <div className="hint">PNG/JPG/WEBP up to 8MB</div>
            </div>
          </div>
        </section>

        {/* Sign-in preference */}
        <section className="profileCard">
          <h2 className="profileTitle">Sign-in preference</h2>

          <label className="profileCheckRow">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Keep me signed in on this device</span>
          </label>

          <div className="profileActionsRow">
            <button type="button" className="profileBtn profileBtnPrimary" onClick={onSaveRemember}>
              Save preference
            </button>
            
          </div>

          {savedPref ? <div className="profileSaved">Saved!</div> : null}

          
        </section>

        {/* ✅ My Rooms */}
        <section className="profileCard">
          <h2 className="profileTitle">Your Rooms</h2>
          <p className="profileSub">
            Rooms you’ve joined. Tap to jump straight into the draft room.
          </p>

          {roomsLoading ? <div>Loading rooms…</div> : null}
          {roomsError ? <div className="profileError">{roomsError}</div> : null}

          {!roomsLoading && !roomsError && rooms.length === 0 ? (
            <div className="hint">
              You’re not in any rooms yet. Join one from the Draft page using a room code.
            </div>
          ) : null}

          <div className="roomsList">
            {rooms.map((r) => (
              <div className="roomRow" key={r.id}>
                <div className="roomInfo">
                  <div className="roomName">{r.name}</div>
                  <div className="roomCompetition">
                    {r.competitionLabel || "Competition not set"}
                  </div>

                  <div className="roomMeta">
                    <span className="roomCode">{r.code}</span>
                    {typeof r.membersCount === "number" ? (
                      <span>Members: {r.membersCount}</span>
                    ) : null}
                  </div>

                  <div className="roomBadges">
                    {r.started ? (
                      <span className="badge badgeLive">Live</span>
                    ) : (
                      <span className="badge badgePending">Not started</span>
                    )}
                  </div>
                </div>

                <div className="roomActions">
                  <button
                    type="button"
                    className="profileBtn profileBtnPrimary"
                    onClick={() => openRoom(r.id)}
                    disabled={deletingRoomId === r.id}
                  >
                    Join
                  </button>
                  <button
                    type="button"
                    className="profileBtn profileBtnDanger"
                    onClick={() => deleteRoomFromMyList(r.id, r.name)}
                    disabled={deletingRoomId === r.id}
                    
                  >
                    {deletingRoomId === r.id ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
