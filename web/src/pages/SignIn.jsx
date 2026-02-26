// web/src/pages/SignIn.jsx
import { useEffect, useState } from "react";
import {
  sendMagicLinkWithPref,
  setRememberMe,
  getRememberMe,
  completeRedirectIfAny,
} from "../firebase";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [remember, setRemember] = useState(true);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    // ensure any inbound magic link finishes
    completeRedirectIfAny().catch(console.error);
    // load the saved preference
    setRemember(getRememberMe());
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    setMsg("");
    try {
      // save preference first (used by sendMagicLinkWithPref)
      setRememberMe(remember);

      setSending(true);
      await sendMagicLinkWithPref(email);
      setMsg("Magic link sent! Check your email.");
    } catch (err) {
      console.error(err);
      setMsg("Failed to send magic link.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-[60vh] grid place-items-center p-6">
      {/*<form onSubmit={onSubmit} className="w-full max-w-sm bg-white p-6 rounded-2xl shadow space-y-3">
        <h1 className="text-xl font-bold text-center">Sign In</h1>

        <input
          className="w-full border rounded px-3 py-2"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>Keep me signed in on this device</span>
        </label>

        <button
          type="submit"
          disabled={sending}
          className="w-full px-3 py-2 rounded-xl border bg-black text-white disabled:opacity-50"
        >
          {sending ? "Sending..." : "Send magic link"}
        </button>

        {msg && <div className="text-sm opacity-80 text-center">{msg}</div>}
      </form> */}
      <div className="w-full max-w-sm bg-white p-6 rounded-2xl shadow space-y-3 text-center">
        <h1 className="text-xl font-bold">Sign In</h1>
        <p className="text-sm opacity-80">
          Please sign in with Google.
        </p>
      </div>
    </div>
  );
}
