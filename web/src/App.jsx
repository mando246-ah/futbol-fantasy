// web/src/App.jsx
import React, { useEffect, useState, useRef } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Link,
  NavLink,
  Navigate,
} from "react-router-dom";

import Draft from "./pages/Draft";             
import Profile from "./pages/Profile";
import DraftSummary from "./pages/DraftSummary";
import Home from "./pages/Home";
import SupportPage from "./pages/SupportPage";
import NewsPage from "./pages/NewsPage";
import SuperAdminFix246 from "./pages/SuperAdminFix246";
import TermsPage from "./pages/Legal/TermsPage";
import PrivacyPage from "./pages/Legal/PrivacyPage";
import CopyrightPage from "./pages/Legal/CopyrightPage";
import DataDeletionPage from "./pages/Legal/DataDeletionPage";
import RoomChatBubble from "./components/RoomChatBubble";
//import TournamentPage from "./pages/TournamentPage/TournamentPage";
import TournamentRouter from "./pages/TournamentPage/TournamentRouter";
import {
  watchAuth,
  signOutNow,
  completeRedirectIfAny,
  watchUserProfile,
  getLastRoomId,
  sendMagicLink,
  completeGoogleRedirectIfAny,
  sendMagicLinkWithPref,
  signInWithGoogleWithPref,
  setRememberMe,
  getRememberMe,
  logPageView,
  logAnalyticsEvent,
  writeUserPresence,
} from "./firebase";


import { Avatar, AvatarImage, AvatarFallback } from "./components/ui/avatar";
import logo from "./assets/logo.png";
import { useLocation, Outlet } from "react-router-dom";
import "./styles/appShell.css";

const OWNER_UIDS = new Set([
  "WspA06q2KlQr7KUq2PP58FMyIJk2",
]);


function Nav({ user, displayName, photoURL }) {
  const [lastRoomId, setLastRoomIdState] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const refresh = () => {
      setLastRoomIdState(user?.uid ? getLastRoomId(user.uid) : "");
    };

    refresh();

    window.addEventListener("lastRoomIdChanged", refresh);
    window.addEventListener("storage", refresh);

    return () => {
      window.removeEventListener("lastRoomIdChanged", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [user?.uid]);

  // close mobile menu on route change (basic)
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("popstate", close);
    return () => window.removeEventListener("popstate", close);
  }, []);

  const isOwner = Boolean(user?.uid && OWNER_UIDS.has(user.uid));

  const tabs = [
    { to: "/", label: "Home" },
    { to: "/news", label: "News" },
    { to: "/draft", label: "Draft", hideWhenNoUser: true },
    {
      to: lastRoomId ? `/room?room=${lastRoomId}` : null,
      label: "View Rosters",
      hideWhenNoUser: true,
      disabled: !lastRoomId,
    },
    {
      to: lastRoomId ? `/tournament/${lastRoomId}` : "/tournament",
      label: "Tournament",
      hideWhenNoUser: true,
      disabled: !lastRoomId,
    },
    { to: "/profile", label: "Profile", hideWhenNoUser: true },
    { to: "/superAdminFix246", label: "Owner Tools", ownerOnly: true },
    { to: "/signin", label: "Sign In", hideWhenAuthed: true },
    { to: "/support", label: "Support Us" },
  ];

  const visibleTabs = tabs.filter(
    (t) =>
      !(t.hideWhenAuthed && user) &&
      !(t.hideWhenNoUser && !user) &&
      !(t.ownerOnly && !isOwner)
  );

  return (
    <header className="ff-nav">
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between gap-3">
        <Link to="/" className="flex items-center gap-3 font-bold text-xl whitespace-nowrap">
          <img
            src={logo}
            alt="Fútbol Fantasy"
            className="h-12 w-16 object-contain shrink-0"
          />
          <span>Fútbol Fantasy - <i>BETA</i></span>
        </Link>
        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-4 text-sm">
          {visibleTabs.map((t) => {
            if (t.disabled || !t.to) {
              return (
                <span key={t.label} className="opacity-50 cursor-not-allowed">
                  {t.label}
                </span>
              );
            }
            return (
              <NavLink
                key={t.to}
                to={t.to}
                className={({ isActive }) =>
                  isActive
                    ? "font-semibold text-blue-600"
                    : "opacity-70 hover:opacity-100"
                }
              >
                {t.label}
              </NavLink>
            );
          })}
        </nav>

        {/* Right side (desktop) */}
        <div className="hidden md:flex items-center gap-3">
          {user ? (
            <>
              <div className="flex items-center gap-2">
                <Avatar className="h-8 w-8">
                  <AvatarImage src={photoURL || ""} alt="Profile picture" />
                  <AvatarFallback>
                    {(displayName || user.email || "?").slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm opacity-80">{displayName || user.email}</span>
              </div>

              <button
                onClick={signOutNow}
                className="px-3 py-1 rounded-lg border bg-red-500 text-white hover:bg-red-600"
              >
                Sign out
              </button>
            </>
          ) : (
            <NavLink
              to="/signin"
              className="px-3 py-1 rounded-lg border bg-blue-600 text-white hover:bg-blue-700"
            >
              Sign In
            </NavLink>
          )}
        </div>

        {/* Mobile menu button */}
        <button
          className="md:hidden px-3 py-2 rounded-lg border border-white/15 bg-white/10 text-white backdrop-blur"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Toggle menu"
        >
          ☰
        </button>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="md:hidden border-t border-white/10 bg-black/60 text-white backdrop-blur">
          <div className="px-4 py-3 flex flex-col gap-3">
            {user && (
              <div className="flex items-center gap-2">
                <Avatar className="h-8 w-8">
                  <AvatarImage src={photoURL || ""} alt="Profile picture" />
                  <AvatarFallback>
                    {(displayName || user.email || "?").slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm opacity-80">{displayName || user.email}</span>
              </div>
            )}

            <nav className="flex flex-col gap-2">
              {visibleTabs.map((t) => {
                if (t.disabled || !t.to) {
                  return (
                    <span key={t.label} className="opacity-50 cursor-not-allowed">
                      {t.label}
                    </span>
                  );
                }
                return (
                  <NavLink
                    key={t.to}
                    to={t.to}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) =>
                      isActive
                        ? "font-semibold text-blue-600"
                        : "opacity-80"
                    }
                  >
                    {t.label}
                  </NavLink>
                );
              })}
            </nav>

            {user ? (
              <button
                onClick={signOutNow}
                className="w-full px-3 py-2 rounded-lg border bg-red-500 text-white hover:bg-red-600"
              >
                Sign out
              </button>
            ) : (
              <NavLink
                to="/signin"
                onClick={() => setOpen(false)}
                className="w-full text-center px-3 py-2 rounded-lg border bg-blue-600 text-white hover:bg-blue-700"
              >
                Sign In
              </NavLink>
            )}
          </div>
        </div>
      )}
    </header>
  );
}


function RequireAuth({ user, children }) {
  if (!user) return <Navigate to="/signin" replace />;
  return children;
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [remember, setRemember] = useState(() => getRememberMe());
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [acceptedLegal, setAcceptedLegal] = useState(false);

  async function onSend(e) {
    e.preventDefault();
    setErr("");
    try {
      setBusy(true);
      setRememberMe(remember);
      await sendMagicLinkWithPref(email);
      setSent(true);
    } catch (e) {
      setErr(e?.message || "Failed to send link.");
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    setErr("");
    if (!acceptedLegal) {
      setErr("Please agree to the Terms of Service and Privacy Policy before signing in.");
      return;
    }

    try {
      setBusy(true);
      setRememberMe(remember);
      await signInWithGoogleWithPref();
      // success will flip auth state; redirect fallback will navigate away
    } catch (e) {
      setErr(e?.message || "Google sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[60vh] grid place-items-center p-6">
      <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md shadow-lg p-6 w-full max-w-md text-white">
        <h1 className="text-xl font-bold mb-2">Sign in</h1>
        <p className="text-sm opacity-80 mb-4 leading-relaxed">
          Sign in to create or join rooms, draft with friends, manage your lineups, and track your tournament live.
        </p>

        <div className="mb-4 grid gap-2 text-sm">
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
            <span className="text-emerald-300">✓</span>
            <span>Create or join private rooms</span>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
            <span className="text-emerald-300">✓</span>
            <span>Manage your starting XI and bench</span>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
            <span className="text-emerald-300">✓</span>
            <span>Follow scores, standings, and matchups</span>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm opacity-90 mb-4 select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>Keep me signed in on this device</span>
        </label>

        <label className="flex items-start gap-3 text-sm opacity-90 mb-2 select-none">
          <input
            type="checkbox"
            checked={acceptedLegal}
            onChange={(e) => setAcceptedLegal(e.target.checked)}
            className="mt-1"
            required
          />
          <span>
            I agree to the{" "}
            <Link className="text-blue-300 hover:text-blue-200 font-semibold underline underline-offset-2" to="/terms">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link className="text-blue-300 hover:text-blue-200 font-semibold underline underline-offset-2" to="/privacy">
              Privacy Policy
            </Link>
            .
          </span>
        </label>

        <p className="text-xs text-slate-300 mb-4">
          Fútbol Fantasy is an independent fantasy soccer platform.
        </p>

        {err && (
          <div className="mb-4 rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2 text-sm text-red-100">
            {err}
          </div>
        )}

        <button
          type="button"
          onClick={onGoogle}
          disabled={busy || !acceptedLegal}
          className="w-full mb-4 px-3 py-2 rounded-xl border border-white/15 bg-white/10 text-white hover:bg-white/15 disabled:opacity-50"
        >
          Continue with Google
        </button>

       
      </div>
    </div>
  );
}


function AppLayout({ user, displayName, photoURL }) {
  const location = useLocation();
  const isHome = location.pathname === "/";

  return (
    <div className="appShell theme-dark">
      <Nav user={user} displayName={displayName} photoURL={photoURL} />
      <main className={isHome ? "appMain appMain--full" : "appMain"}>
        <Outlet />
      </main>
    </div>
  );
}

//Analytics
function AnalyticsRouteTracker() {
  const location = useLocation();

  useEffect(() => {
    const { pathname, search } = location;

    // Nice clean titles per route (fixes your "Football/Fútbol/Fútball" duplicates too)
    let title = "Fútbol Fantasy";
    if (pathname === "/") title = "Fútbol Fantasy — Home";
    else if (pathname === "/signin") title = "Fútbol Fantasy — Sign In";
    else if (pathname === "/profile") title = "Fútbol Fantasy — Profile";
    else if (pathname === "/draft") title = "Fútbol Fantasy — Draft";
    else if (pathname === "/room") title = "Fútbol Fantasy — Rosters";
    else if (pathname.startsWith("/tournament")) title = "Fútbol Fantasy — Tournament";
    else if (pathname === "/news") title = "Fútbol Fantasy — News & Updates";

    document.title = title;

    // Log a page_view for every route change (SPA fix)
    logPageView({
      page_path: pathname + search,
      page_title: title,
    });
  }, [location.pathname, location.search]);

  return null;
}

function PresenceTracker({ user, displayName, photoURL }) {
  const location = useLocation();

  useEffect(() => {
    if (!user?.uid) return undefined;

    let cancelled = false;

    const ping = async () => {
      if (cancelled) return;
      try {
        await writeUserPresence(user, {
          displayName,
          photoURL,
          path: location.pathname || "",
        });
      } catch (e) {
        console.warn("[presence] failed to update", e);
      }
    };

    ping();

    const intervalId = window.setInterval(ping, 2 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [user?.uid, user?.displayName, user?.photoURL, displayName, photoURL, location.pathname]);

  return null;
}

function RoomChatRouteMount({ user, displayName }) {
  const location = useLocation();
  const [lastRoomId, setLastRoomIdState] = useState("");

  useEffect(() => {
    const refresh = () => {
      setLastRoomIdState(user?.uid ? getLastRoomId(user.uid) : "");
    };

    refresh();
    window.addEventListener("lastRoomIdChanged", refresh);
    window.addEventListener("storage", refresh);

    return () => {
      window.removeEventListener("lastRoomIdChanged", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [user?.uid]);

  if (!user?.uid) return null;

  const pathname = location.pathname || "";
  const isDraftPage = pathname === "/draft";
  const isRosterPage = pathname === "/room";
  const tournamentMatch = pathname.match(/^\/tournament\/([^/]+)$/);
  const isTournamentPage = pathname === "/tournament" || Boolean(tournamentMatch);

  if (!isDraftPage && !isRosterPage && !isTournamentPage) return null;

  const queryRoomId = new URLSearchParams(location.search).get("room") || "";
  let tournamentRoomId = "";
  if (tournamentMatch?.[1]) {
    try {
      tournamentRoomId = decodeURIComponent(tournamentMatch[1]);
    } catch {
      tournamentRoomId = tournamentMatch[1];
    }
  }

  const roomId = String(
    tournamentRoomId ||
    queryRoomId ||
    ((isDraftPage || isRosterPage) ? lastRoomId : "")
  ).trim();

  if (!roomId) return null;

  return (
    <RoomChatBubble
      roomId={roomId}
      user={user}
      displayName={displayName || user.displayName || ""}
    />
  );
}

// ---------- App ----------
export default function App() {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const displayName = profile?.displayName;
  const photoURL = profile?.photoURL;
  const loginLoggedRef = useRef(false);

  useEffect(() => {
    completeGoogleRedirectIfAny().catch(console.error);

    const unsub = watchAuth((u) => {
      setUser(u);

      // Log once per login
      if (u && !loginLoggedRef.current) {
        loginLoggedRef.current = true;

        logAnalyticsEvent("login_success", {
          method: u.providerData?.[0]?.providerId || "unknown",
        });
      }

      // Reset when signed out so it can log next time
      if (!u) {
        loginLoggedRef.current = false;
      }
    });

    return unsub;
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setProfile(null);
      return;
    }
    return watchUserProfile(user.uid, setProfile);
  }, [user?.uid]);

  return (
    <Router>
      <AnalyticsRouteTracker />
      <PresenceTracker user={user} displayName={displayName} photoURL={photoURL} />
      <RoomChatRouteMount user={user} displayName={displayName} />
      <Routes>
        <Route element={<AppLayout user={user} displayName={displayName} photoURL={photoURL} />}>
          <Route path="/" element={<Home user={user} />} />
          <Route path="*" element={<Home user={user} />} />

          <Route path="/signin" element={user ? <Navigate to="/" replace /> : <SignIn />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/copyright" element={<CopyrightPage />} />
          <Route path="/data-deletion" element={<DataDeletionPage />} />
          <Route path="/news" element={<NewsPage />} />

          <Route path="/profile" element={
            <RequireAuth user={user}>
              <Profile />
            </RequireAuth>
          } />

          <Route path="/draft" element={
            user && !displayName ? (
              <Navigate to="/profile" replace />
            ) : (
              <RequireAuth user={user}>
                <Draft />
              </RequireAuth>
            )
          } />

          <Route path="/room" element={
            <RequireAuth user={user}>
              <DraftSummary />
            </RequireAuth>
          } />

          <Route path="/tournament" element={
            <RequireAuth user={user}><TournamentRouter /></RequireAuth>
          } />
          <Route path="/tournament/:roomId" element={
            <RequireAuth user={user}><TournamentRouter /></RequireAuth>
          } />
          <Route path="/support" element={<SupportPage />} />
          <Route path="/superAdminFix246" element={
            <RequireAuth user={user}>
              <SuperAdminFix246 />
            </RequireAuth>
          } />
        </Route>
      </Routes>
    </Router>
  );
}
