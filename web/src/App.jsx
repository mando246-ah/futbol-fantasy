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
} from "./firebase";

import { Avatar, AvatarImage, AvatarFallback } from "./components/ui/avatar";
import logo from "./assets/logo.png";
import { useLocation, Outlet } from "react-router-dom";
import "./styles/appShell.css";


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

  const tabs = [
    { to: "/", label: "Home" },
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
    { to: "/signin", label: "Sign In", hideWhenAuthed: true },
  ];

  const visibleTabs = tabs.filter(
    (t) => !(t.hideWhenAuthed && user) && !(t.hideWhenNoUser && !user)
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
        <p className="text-sm opacity-70 mb-4">Please sign in with Google</p>

        <label className="flex items-center gap-2 text-sm opacity-90 mb-4 select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>Keep me signed in on this device</span>
        </label>

        <button
          type="button"
          onClick={onGoogle}
          disabled={busy}
          className="w-full mb-4 px-3 py-2 rounded-xl border border-white/15 bg-white/10 text-white hover:bg-white/15 disabled:opacity-50"
        >
          Continue with Google
        </button>

        {/*<div className="flex items-center gap-3 mb-4">
          <div className="h-px flex-1 bg-white/10" />
          <div className="text-xs opacity-50">OR</div>
          <div className="h-px flex-1 bg-white/10" />
        </div>

        {!sent ? (
          <form onSubmit={onSend} className="space-y-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-white placeholder:text-white/40 outline-none focus:ring-2 focus:ring-cyan-400/40"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full px-3 py-2 rounded-xl border border-white/10 bg-gradient-to-r from-fuchsia-500/80 to-cyan-400/80 text-white hover:from-fuchsia-500 hover:to-cyan-400 disabled:opacity-50"
            >
              {busy ? "Working..." : "Send magic link"}
            </button>
          </form>
        ) : (
          <div className="text-sm">
            We sent a link to <b>{email}</b>. Open it here to finish sign-in.
          </div>
        )}

        {err && <div className="text-red-600 text-sm mt-3">{String(err)}</div>} */}
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

    document.title = title;

    // Log a page_view for every route change (SPA fix)
    logPageView({
      page_path: pathname + search,
      page_title: title,
    });
  }, [location.pathname, location.search]);

  return null;
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

  useEffect(() => {
    const unsub = watchAuth((u) => {
      setUser(u);

      if (u && !loginLoggedRef.current) {
        loginLoggedRef.current = true;

        logAnalyticsEvent("login_success", {
          method: u.providerData?.[0]?.providerId || "unknown",
        });
      }

      if (!u) {
        loginLoggedRef.current = false; // allow it to log next time user logs in
      }
    });

    return () => unsub?.();
  }, []);

  return (
    <Router>
      <AnalyticsRouteTracker />
      <Routes>
        <Route element={<AppLayout user={user} displayName={displayName} photoURL={photoURL} />}>
          <Route path="/" element={<Home user={user} />} />
          <Route path="*" element={<Home user={user} />} />

          <Route path="/signin" element={user ? <Navigate to="/" replace /> : <SignIn />} />

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

          {/*<Route path="/tournament" element={
            <RequireAuth user={user}><TournamentPage /></RequireAuth>
          } />
          <Route path="/tournament/:roomId" element={
            <RequireAuth user={user}><TournamentPage /></RequireAuth>
          } /> */}
          <Route path="/tournament" element={
            <RequireAuth user={user}><TournamentRouter /></RequireAuth>
          } />
          <Route path="/tournament/:roomId" element={
            <RequireAuth user={user}><TournamentRouter /></RequireAuth>
          } />
        </Route>
      </Routes>
    </Router>
  );
}
