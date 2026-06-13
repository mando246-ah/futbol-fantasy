import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { auth, db } from "../../firebase";
import { createTradeOffer, respondToTradeOffer, applyAcceptedTrade } from "../../firebase";
import {
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import useUserProfiles from "../../lib/useUserProfiles";
import "./TradePanel.css";
import {
  friendlyErrorMessage,
  reportClientError,
} from "../../utils/errorReporter";
import { devError, devLog } from "../../utils/devLogger";

function statusLabel(s) {
  if (s === "pending") return "Offer Pending";
  if (s === "accepted") return "Offer Accepted (waiting host)";
  if (s === "rejected") return "Offer Rejected";
  if (s === "canceled" || s === "cancelled") return "Offer Canceled";
  if (s === "completed") return "Trade Completed";
  return s || "—";
}

function statusClass(s) {
  return `tradeStatus tradeStatus--${s || "unknown"}`;
}

function pickOwnerUid(p = {}) {
  return String(
    p.uid ||
    p.ownerUid ||
    p.userId ||
    p.managerUid ||
    p.pickedByUid ||
    p.pickedBy ||
    p.owner?.uid ||
    p.owner?.id ||
    ""
  ).trim();
}

function pickPlayerId(p = {}, fallback = "") {
  return String(
    p.playerId ||
    p.pid ||
    p.apiPlayerId ||
    p.player?.id ||
    p.id ||
    fallback ||
    ""
  ).trim();
}

function pickDisplayName(p = {}) {
  return (
    p.name ||
    p.playerName ||
    p.fullName ||
    p.displayName ||
    p.player?.name ||
    "Unknown"
  );
}

function pickDocumentId(p = {}) {
  return String(p.pickDocId || p.docId || p.id || "").trim();
}

function normalizeRosterPick(p = {}) {
  const id = pickDocumentId(p);
  return {
    ...p,
    id,
    playerId: pickPlayerId(p, p.id),
    playerName: pickDisplayName(p),
  };
}

function pickSortValue(p = {}) {
  const direct = Number(
    p.turn ??
    p.pickIndex ??
    p.overallPick ??
    p.pickNumber ??
    p.createdAtMs
  );
  if (Number.isFinite(direct)) return direct;
  if (typeof p.createdAt?.toMillis === "function") return p.createdAt.toMillis();
  if (Number.isFinite(Number(p.createdAt?.seconds))) {
    return Number(p.createdAt.seconds) * 1000;
  }
  return Number.MAX_SAFE_INTEGER;
}

function fmtSide(arr) {
  if (!arr?.length) return "—";
  return arr.map(p => `${pickDisplayName(p)} (${p.position || "SUB"})`).join(", ");
}

function memberUidOf(member) {
  return String(
    typeof member === "string"
      ? member
      : member?.uid ?? member?.userId ?? member?.id ?? ""
  ).trim();
}

function tradeTimestampMs(trade = {}) {
  const direct = Number(trade.updatedAtMs || trade.createdAtMs || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  if (typeof trade.updatedAt?.toMillis === "function") {
    return trade.updatedAt.toMillis();
  }
  if (typeof trade.createdAt?.toMillis === "function") {
    return trade.createdAt.toMillis();
  }
  return 0;
}

export default function TradePanel({ tradeRoomPath, room, picks }) {
  const myUid = auth.currentUser?.uid || null;
  const isHost = !!myUid && room?.hostUid === myUid;

  const [trades, setTrades] = useState([]);
  const [tradeMsg, setTradeMsg] = useState("");
  const [tradeHistoryLoaded, setTradeHistoryLoaded] = useState(false);
  const [tradeHistoryLoading, setTradeHistoryLoading] = useState(false);
  const [tradeHistory, setTradeHistory] = useState([]);
  const [tradeHistoryError, setTradeHistoryError] = useState("");

  const [partnerUid, setPartnerUid] = useState("");
  const [givePickIds, setGivePickIds] = useState(["", ""]);
  const [recvPickIds, setRecvPickIds] = useState(["", ""]);

  // Keep only actionable offers live. Historical trades are loaded on demand.
  useEffect(() => {
    if (!tradeRoomPath) return;
    const ref = collection(db, "rooms", tradeRoomPath, "trades");
    const qy = query(
      ref,
      where("status", "in", ["pending", "accepted"]),
      limit(50)
    );
    return onSnapshot(
      qy,
      (snap) => {
        setTrades(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        devLog("[TradePanel] trades snapshot", {
          roomId: tradeRoomPath,
          tradeDocsRead: snap.size,
        });
      },
      (error) => {
        devError("[TradePanel] trades listener failed", error);
        setTradeMsg("Could not load trades. Please refresh and try again.");
      }
    );
  }, [tradeRoomPath]);

  const loadTradeHistory = useCallback(async () => {
    if (!tradeRoomPath) {
      setTradeHistory([]);
      setTradeHistoryLoaded(false);
      return;
    }

    setTradeHistoryLoading(true);
    setTradeHistoryError("");
    try {
      const ref = collection(db, "rooms", tradeRoomPath, "trades");
      const snap = await getDocs(
        query(ref, orderBy("updatedAt", "desc"), limit(50))
      );

      const historyStatuses = new Set([
        "completed",
        "accepted",
        "rejected",
        "canceled",
        "cancelled",
      ]);
      const rows = snap.docs
        .map((tradeDoc) => ({ id: tradeDoc.id, ...(tradeDoc.data() || {}) }))
        .filter((trade) => historyStatuses.has(String(trade.status || "")))
        .sort((a, b) => tradeTimestampMs(b) - tradeTimestampMs(a));

      setTradeHistory(rows);
      setTradeHistoryLoaded(true);
      devLog("[TradePanel] trade history read", {
        roomId: tradeRoomPath,
        tradeDocsRead: snap.size,
        historyRows: rows.length,
      });
    } catch (error) {
      devError("[TradePanel] trade history read failed", error);
      setTradeHistoryError("Could not load trade history.");
    } finally {
      setTradeHistoryLoading(false);
    }
  }, [tradeRoomPath]);

  useEffect(() => {
    setTradeHistory([]);
    setTradeHistoryError("");
    setTradeHistoryLoaded(false);
    setTradeHistoryLoading(false);
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
        .catch(async (e) => {
          const userMessage = friendlyErrorMessage(
            e,
            "Could not complete the accepted trade. Please try again."
          );
          await reportClientError({
            roomId: tradeRoomPath,
            area: "TradePanel",
            action: "applyAcceptedTrade",
            error: e,
            userMessage,
            extra: { tradeId: t.id },
          });
          devError("[TradePanel] applyAcceptedTrade failed", e);
          setTradeMsg(userMessage);
        })
        .finally(() => applyingRef.current.delete(t.id));
    }
  }, [tradeRoomPath, isHost, trades]);

  // Members + names
  const members = useMemo(
    () => (Array.isArray(room?.members) ? room.members : []),
    [room?.members]
  );
  const managerUids = useMemo(() => {
    const ids = new Set();

    for (const member of members) {
      const uid = memberUidOf(member);
      if (uid) ids.add(uid);
    }

    for (const pick of Array.isArray(picks) ? picks : []) {
      const uid = pickOwnerUid(pick);
      if (uid) ids.add(uid);
    }

    for (const trade of [...trades, ...tradeHistory]) {
      if (trade?.fromUid) ids.add(String(trade.fromUid));
      if (trade?.toUid) ids.add(String(trade.toUid));
    }

    return Array.from(ids);
  }, [members, picks, tradeHistory, trades]);
  const profilesByUid = useUserProfiles(managerUids);
  const managerName = useCallback((uid, fallback = "Manager") => {
    const profile = profilesByUid?.[String(uid || "")] || {};
    return profile?.displayName || profile?.name || fallback || "Manager";
  }, [profilesByUid]);
  const nameByUid = useMemo(() => {
    const m = new Map();
    for (const mem of members) {
      const uid = memberUidOf(mem);
      if (uid) m.set(uid, managerName(uid, mem?.displayName || uid));
    }
    for (const pick of Array.isArray(picks) ? picks : []) {
      const uid = pickOwnerUid(pick);
      if (uid && !m.has(uid)) {
        m.set(uid, managerName(uid, pick?.displayName || pick?.managerName || uid));
      }
    }
    return m;
  }, [managerName, members, picks]);

  const normalizedPicks = useMemo(
    () =>
      (Array.isArray(picks) ? picks : [])
        .map(normalizeRosterPick)
        .filter((pick) => pick.id),
    [picks]
  );

  // Group picks by uid
  const picksByUid = useMemo(() => {
    const map = new Map();
    for (const p of normalizedPicks) {
      const uid = pickOwnerUid(p);
      if (!uid) continue;
      if (!map.has(uid)) map.set(uid, []);
      map.get(uid).push(p);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) =>
        pickSortValue(a) - pickSortValue(b) ||
        pickDisplayName(a).localeCompare(pickDisplayName(b))
      );
    }
    return map;
  }, [normalizedPicks]);

  const myRoster = picksByUid.get(String(myUid || "")) || [];
  const partnerRoster = picksByUid.get(String(partnerUid || "")) || [];

  const partnerOptions = useMemo(() => {
    const memberByUid = new Map(
      members
        .map((member) => [memberUidOf(member), member])
        .filter(([uid]) => Boolean(uid))
    );

    return managerUids
      .filter((uid) => uid && uid !== myUid)
      .map((uid) => {
        const member = memberByUid.get(uid);
        return {
          uid,
          name: managerName(
            uid,
            member?.displayName || nameByUid.get(uid) || uid
          ),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [managerName, managerUids, members, myUid, nameByUid]);

  function pickById(pickId) {
    const id = String(pickId || "");
    return normalizedPicks.find((p) => p.id === id) || null;
  }

  function normalizeSelected(arr) {
    return Array.from(
      new Set((arr || []).map((id) => String(id || "").trim()).filter(Boolean))
    ).slice(0, 2);
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

    if (giveIds.length < 1 && recvIds.length < 1) {
      return setTradeMsg("Select at least one player to give or receive.");
    }
    if (giveIds.length < 1 || recvIds.length < 1) {
      return setTradeMsg("Pick at least 1 player on each side.");
    }
    if (giveIds.length !== recvIds.length) {
      return setTradeMsg("Must be 1-for-1 or 2-for-2.");
    }
    if (giveIds.some((id) => recvIds.includes(id))) {
      return setTradeMsg("The same pick cannot appear on both sides of a trade.");
    }

    // Defensive: ensure they belong to the correct rosters
    const myIds = new Set(myRoster.map((p) => String(p.id)));
    const partnerIds = new Set(partnerRoster.map((p) => String(p.id)));
    if (giveIds.some(id => !myIds.has(id))) return setTradeMsg("One of your 'give' picks is not on your roster.");
    if (recvIds.some(id => !partnerIds.has(id))) return setTradeMsg("One of your 'receive' picks is not on the partner roster.");

    const normalizeTradePick = (p) => ({
      pickId: String(p.id),
      playerId: pickPlayerId(p, p.id),
      playerName: pickDisplayName(p),
      position: p.position || "SUB",
      teamName: p.teamName || "",
      teamLogo: p.teamLogo || "",
      nationality: p.nationality || "",
    });
    const give = giveIds.map(id => pickById(id)).filter(Boolean).map(normalizeTradePick);
    const receive = recvIds.map(id => pickById(id)).filter(Boolean).map(normalizeTradePick);

    if (give.length !== giveIds.length || receive.length !== recvIds.length) {
      return setTradeMsg("One or more selected players could not be resolved.");
    }

    try {
      await createTradeOffer({ roomId: tradeRoomPath, toUid: partnerUid, give, receive });
      setTradeMsg("✅ Offer sent!");
      setGivePickIds(["", ""]);
      setRecvPickIds(["", ""]);
    } catch (e) {
      const userMessage = friendlyErrorMessage(
        e,
        "Could not send the trade offer. Please try again."
      );
      await reportClientError({
        roomId: tradeRoomPath,
        area: "TradePanel",
        action: "createTradeOffer",
        error: e,
        userMessage,
        extra: {
          partnerUid,
          giveCount: give.length,
          receiveCount: receive.length,
        },
      });
      devError("[TradePanel] createTradeOffer failed", e);
      setTradeMsg(userMessage);
    }
  }

  async function act(tradeId, action) {
    setTradeMsg("");
    try {
      await respondToTradeOffer({ roomId: tradeRoomPath, tradeId, action });
    } catch (e) {
      const userMessage = friendlyErrorMessage(
        e,
        "Could not update this trade. Please refresh and try again."
      );
      await reportClientError({
        roomId: tradeRoomPath,
        area: "TradePanel",
        action: "respondToTradeOffer",
        error: e,
        userMessage,
        extra: { tradeId, responseAction: action },
      });
      devError("[TradePanel] respondToTradeOffer failed", e);
      setTradeMsg(userMessage);
    }
  }

  const incoming = trades.filter(t => t.toUid === myUid);
  const outgoing = trades.filter(t => t.fromUid === myUid);

  const incomingPending = incoming.filter(t => t.status === "pending");
  const outgoingPending = outgoing.filter(t => t.status === "pending");

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
                    <option key={pickDocumentId(p)} value={pickDocumentId(p)}>
                      {pickDisplayName(p)} ({p.position || p.pos || "SUB"})
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
                    <option key={pickDocumentId(p)} value={pickDocumentId(p)}>
                      {pickDisplayName(p)} ({p.position || p.pos || "SUB"})
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
          <div className="tradeHistoryHeader">
            <div className="tradeCardTitle">Trade history</div>
            <button
              type="button"
              className="tradeBtn tradeBtn--ghost"
              disabled={tradeHistoryLoading}
              onClick={loadTradeHistory}
            >
              {tradeHistoryLoading
                ? "Loading Trade History..."
                : tradeHistoryLoaded
                  ? "Refresh Trade History"
                  : "Load Trade History"}
            </button>
          </div>

          <div className="tradeHistoryHelp">
            Trade history is loaded only when requested to save reads.
          </div>

          {tradeHistoryError && (
            <div className="tradeHistoryError">{tradeHistoryError}</div>
          )}

          {tradeHistoryLoaded && tradeHistory.length === 0 && (
            <div className="tradeEmpty">No trade history yet.</div>
          )}

          {tradeHistory.map(t => (
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

        </div>
      )}
    </div>
  );
}
