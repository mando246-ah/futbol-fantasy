import { useEffect, useMemo, useRef, useState } from "react";
import { auth, db } from "../../firebase";
import { createTradeOffer, respondToTradeOffer, applyAcceptedTrade } from "../../firebase";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import useUserProfiles from "../../lib/useUserProfiles";
import "./TradePanel.css";

function statusLabel(s) {
  if (s === "pending") return "Offer Pending";
  if (s === "accepted") return "Offer Accepted (waiting host)";
  if (s === "rejected") return "Offer Rejected";
  if (s === "canceled") return "Offer Canceled";
  if (s === "completed") return "Trade Completed";
  return s || "—";
}

function statusClass(s) {
  return `tradeStatus tradeStatus--${s || "unknown"}`;
}

function fmtSide(arr) {
  if (!arr?.length) return "—";
  return arr.map(p => `${p.playerName} (${p.position || "SUB"})`).join(", ");
}

function memberUidOf(member) {
  return String(
    typeof member === "string"
      ? member
      : member?.uid ?? member?.userId ?? member?.id ?? ""
  ).trim();
}

export default function TradePanel({ roomId, tradeRoomPath, room, picks }) {
  const myUid = auth.currentUser?.uid || null;
  const isHost = !!myUid && room?.hostUid === myUid;

  const [trades, setTrades] = useState([]);
  const [tradeMsg, setTradeMsg] = useState("");

  const [partnerUid, setPartnerUid] = useState("");
  const [givePickIds, setGivePickIds] = useState(["", ""]);
  const [recvPickIds, setRecvPickIds] = useState(["", ""]);

  // Listen to trades
  useEffect(() => {
    if (!tradeRoomPath) return;
    const ref = collection(db, "rooms", tradeRoomPath, "trades");
    const qy = query(ref, orderBy("createdAt", "desc"));
    return onSnapshot(qy, (snap) => {
      setTrades(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }, [tradeRoomPath]);

  // Host auto-applies accepted trades
  const applyingRef = useRef(new Set());
  useEffect(() => {
    if (!tradeRoomPath || !isHost) return;

    const toApply = trades.filter(t => t.status === "accepted" && !t.appliedAt);
    for (const t of toApply) {
      if (applyingRef.current.has(t.id)) continue;
      applyingRef.current.add(t.id);

      applyAcceptedTrade({ roomId: tradeRoomPath, tradeId: t.id })
        .catch((e) => console.error("applyAcceptedTrade failed:", e))
        .finally(() => applyingRef.current.delete(t.id));
    }
  }, [tradeRoomPath, isHost, trades]);

  // Members + names
  const members = Array.isArray(room?.members) ? room.members : [];
  const managerUids = useMemo(() => {
    const ids = new Set();

    for (const member of members) {
      const uid = memberUidOf(member);
      if (uid) ids.add(uid);
    }

    for (const pick of Array.isArray(picks) ? picks : []) {
      const uid = String(pick?.uid || pick?.ownerUid || "").trim();
      if (uid) ids.add(uid);
    }

    for (const trade of trades) {
      if (trade?.fromUid) ids.add(String(trade.fromUid));
      if (trade?.toUid) ids.add(String(trade.toUid));
    }

    return Array.from(ids);
  }, [members, picks, trades]);
  const profilesByUid = useUserProfiles(managerUids);
  const managerName = (uid, fallback = "Manager") => {
    const profile = profilesByUid?.[String(uid || "")] || {};
    return profile?.displayName || profile?.name || fallback || "Manager";
  };
  const nameByUid = useMemo(() => {
    const m = new Map();
    for (const mem of members) {
      const uid = memberUidOf(mem);
      if (uid) m.set(uid, managerName(uid, mem?.displayName || uid));
    }
    return m;
  }, [members, profilesByUid]);

  // Group picks by uid
  const picksByUid = useMemo(() => {
    const map = new Map();
    for (const p of (picks || [])) {
      if (!p?.uid) continue;
      if (!map.has(p.uid)) map.set(p.uid, []);
      map.get(p.uid).push(p);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0));
    }
    return map;
  }, [picks]);

  const myRoster = picksByUid.get(myUid) || [];
  const partnerRoster = picksByUid.get(partnerUid) || [];

  const partnerOptions = useMemo(() => {
    return members
      .map((m) => ({ uid: memberUidOf(m), member: m }))
      .filter(({ uid }) => uid && uid !== myUid)
      .map(({ uid, member }) => ({ uid, name: managerName(uid, member?.displayName || uid) }));
  }, [members, myUid, profilesByUid]);

  function pickById(pickId) {
    return (picks || []).find(p => p.id === pickId) || null;
  }

  function normalizeSelected(arr) {
    return arr.filter(Boolean).slice(0, 2);
  }

  function updateTwo(setter, idx, val) {
    setter(prev => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  }

  async function onSendOffer() {
    setTradeMsg("");

    if (!tradeRoomPath) return setTradeMsg("Missing room path.");
    if (!myUid) return setTradeMsg("Sign in first.");
    if (!partnerUid) return setTradeMsg("Pick a manager to trade with.");

    const giveIds = normalizeSelected(givePickIds);
    const recvIds = normalizeSelected(recvPickIds);

    if (giveIds.length < 1 || recvIds.length < 1) {
      return setTradeMsg("Pick at least 1 player on each side.");
    }
    if (giveIds.length !== recvIds.length) {
      return setTradeMsg("Must be 1-for-1 or 2-for-2.");
    }

    const give = giveIds.map(id => pickById(id)).filter(Boolean).map(p => ({
      playerId: String(p.playerId),
      playerName: p.playerName,
      position: p.position || "SUB",
    }));
    const receive = recvIds.map(id => pickById(id)).filter(Boolean).map(p => ({
      playerId: String(p.playerId),
      playerName: p.playerName,
      position: p.position || "SUB",
    }));

    // Defensive: ensure they belong to the correct rosters
    const myIds = new Set(myRoster.map(p => p.id));
    const partnerIds = new Set(partnerRoster.map(p => p.id));
    if (giveIds.some(id => !myIds.has(id))) return setTradeMsg("One of your 'give' picks is not on your roster.");
    if (recvIds.some(id => !partnerIds.has(id))) return setTradeMsg("One of your 'receive' picks is not on the partner roster.");

    try {
      await createTradeOffer({ roomId: tradeRoomPath, toUid: partnerUid, give, receive });
      setTradeMsg("✅ Offer sent!");
      setGivePickIds(["", ""]);
      setRecvPickIds(["", ""]);
    } catch (e) {
      console.error(e);
      setTradeMsg(e?.message || "Failed to send offer.");
    }
  }

  async function act(tradeId, action) {
    setTradeMsg("");
    try {
      await respondToTradeOffer({ roomId: tradeRoomPath, tradeId, action });
    } catch (e) {
      console.error(e);
      setTradeMsg(e?.message || "Action failed.");
    }
  }

  const incoming = trades.filter(t => t.toUid === myUid);
  const outgoing = trades.filter(t => t.fromUid === myUid);

  const incomingPending = incoming.filter(t => t.status === "pending");
  const outgoingPending = outgoing.filter(t => t.status === "pending");

  const history = trades.filter(t =>
    t.status === "completed" || t.status === "rejected" || t.status === "canceled" || t.status === "accepted"
  );

  return (
    <div className="tradePanel">
      <div className="tradePanelHeader">
        <div className="tradeTitle">Trades</div>
        <div className="tradeSubtitle">
          Send 1-for-1 or 2-for-2 offers. Recipient accepts/rejects. Host applies accepted trades automatically.
        </div>
      </div>

      <div className="tradeGrid">
        {/* Propose */}
        <div className="tradeCard">
          <div className="tradeCardTitle">Propose a trade</div>

          <label className="tradeLabel">Trade with</label>
          <select
            className="tradeSelect"
            value={partnerUid}
            onChange={(e) => {
              setPartnerUid(e.target.value);
              setRecvPickIds(["", ""]);
            }}
          >
            <option value="">— Select manager —</option>
            {partnerOptions.map(o => (
              <option key={o.uid} value={o.uid}>{o.name}</option>
            ))}
          </select>

          <div className="tradeRow2">
            <div>
              <label className="tradeLabel">You give (max 2)</label>
              {[0, 1].map(i => (
                <select
                  key={`give-${i}`}
                  className="tradeSelect"
                  value={givePickIds[i]}
                  onChange={(e) => updateTwo(setGivePickIds, i, e.target.value)}
                >
                  <option value="">— Select your player —</option>
                  {myRoster.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.playerName} ({p.position})
                    </option>
                  ))}
                </select>
              ))}
            </div>

            <div>
              <label className="tradeLabel">You receive (max 2)</label>
              {[0, 1].map(i => (
                <select
                  key={`recv-${i}`}
                  className="tradeSelect"
                  value={recvPickIds[i]}
                  onChange={(e) => updateTwo(setRecvPickIds, i, e.target.value)}
                  disabled={!partnerUid}
                >
                  <option value="">— Select their player —</option>
                  {partnerRoster.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.playerName} ({p.position})
                    </option>
                  ))}
                </select>
              ))}
            </div>
          </div>

          <button className="tradeBtn" onClick={onSendOffer} disabled={!partnerUid}>
            Send Offer
          </button>

          {tradeMsg && <div className="tradeMsg">{tradeMsg}</div>}
        </div>

        {/* Incoming */}
        <div className="tradeCard">
          <div className="tradeCardTitle">Incoming offers</div>

          {incomingPending.length === 0 && <div className="tradeEmpty">No incoming pending offers.</div>}

          {incomingPending.map(t => (
            <div key={t.id} className="tradeItem">
              <div className="tradeItemTop">
                <div className="tradeItemFrom">
                  From: <b>{managerName(t.fromUid, t.fromName || nameByUid.get(t.fromUid) || t.fromUid)}</b>
                </div>
                <div className={statusClass(t.status)}>{statusLabel(t.status)}</div>
              </div>

              <div className="tradeItemBody">
                <div><b>They give:</b> {fmtSide(t.give)}</div>
                <div><b>You give:</b> {fmtSide(t.receive)}</div>
              </div>

              <div className="tradeActions">
                <button className="tradeBtn tradeBtn--ghost" onClick={() => act(t.id, "reject")}>Reject</button>
                <button className="tradeBtn" onClick={() => act(t.id, "accept")}>Accept</button>
              </div>
            </div>
          ))}
        </div>

        {/* Outgoing */}
        <div className="tradeCard">
          <div className="tradeCardTitle">Your outgoing offers</div>

          {outgoingPending.length === 0 && <div className="tradeEmpty">No outgoing pending offers.</div>}

          {outgoingPending.map(t => (
            <div key={t.id} className="tradeItem">
              <div className="tradeItemTop">
                <div className="tradeItemFrom">
                  To: <b>{managerName(t.toUid, t.toName || nameByUid.get(t.toUid) || t.toUid)}</b>
                </div>
                <div className={statusClass(t.status)}>{statusLabel(t.status)}</div>
              </div>

              <div className="tradeItemBody">
                <div><b>You give:</b> {fmtSide(t.give)}</div>
                <div><b>They give:</b> {fmtSide(t.receive)}</div>
              </div>

              <div className="tradeActions">
                <button className="tradeBtn tradeBtn--ghost" onClick={() => act(t.id, "cancel")}>Cancel</button>
              </div>
            </div>
          ))}
        </div>

        {/* History */}
        <div className="tradeCard tradeCard--wide">
          <div className="tradeCardTitle">Trade history</div>

          {history.length === 0 && <div className="tradeEmpty">No trade history yet.</div>}

          {history.map(t => (
            <div key={t.id} className="tradeItem tradeItem--compact">
              <div className="tradeItemTop">
                <div className="tradeItemFrom">
                  <b>{managerName(t.fromUid, t.fromName || nameByUid.get(t.fromUid) || t.fromUid)}</b> ↔{" "}
                  <b>{managerName(t.toUid, t.toName || nameByUid.get(t.toUid) || t.toUid)}</b>
                </div>
                <div className={statusClass(t.status)}>{statusLabel(t.status)}</div>
              </div>

              <div className="tradeItemBody">
                <div><b>From gives:</b> {fmtSide(t.give)}</div>
                <div><b>To gives:</b> {fmtSide(t.receive)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {isHost && (
        <div className="tradeHostNote">
          Host mode: accepted offers will be applied automatically.
        </div>
      )}
    </div>
  );
}
