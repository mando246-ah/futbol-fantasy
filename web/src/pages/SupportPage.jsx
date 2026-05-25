import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Heart,
  CreditCard,
  MessageSquare,
  Send,
  CheckCircle2,
  AlertTriangle,
  FileText,
  ShieldCheck,
  Copyright,
  Trash2,
} from "lucide-react";
import { getFunctions, httpsCallable } from "firebase/functions";
import { getAuth } from "firebase/auth";
import "./SupportPage.css";

const STRIPE_SUPPORT_LINK = "https://donate.stripe.com/aFa28k8vxgDH0Um5hM4AU00"; 

const MESSAGE_TYPES = [
  { value: "bug", label: "Bug Report" },
  { value: "suggestion", label: "Suggestion" },
  { value: "question", label: "Question" },
  { value: "other", label: "Other" },
];

const LEGAL_LINKS = [
  {
    to: "/terms",
    title: "Terms of Service",
    text: "Review the terms of service",
    icon: FileText,
  },
  {
    to: "/privacy",
    title: "Privacy Policy",
    text: "Review the privacy policy",
    icon: ShieldCheck,
  },
  {
    to: "/copyright",
    title: "Copyright Policy",
    text: "Review the copyright policy",
    icon: Copyright,
  },
  {
    to: "/data-deletion",
    title: "Data Deletion Request",
    text: "Review the data deletion request.",
    icon: Trash2,
  },
];

export default function SupportPage() {
  const stripeReady = Boolean(STRIPE_SUPPORT_LINK);

  const auth = getAuth();
  const user = auth.currentUser;

  const [messageType, setMessageType] = useState("");
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [status, setStatus] = useState(null);

  const selectedTypeLabel = useMemo(() => {
    return (
        MESSAGE_TYPES.find((item) => item.value === messageType)?.label ||
        "Support Message"
    );
   }, [messageType]);

  async function handleSubmitFeedback(e) {
    e.preventDefault();
    setStatus(null);

    const cleanMessage = message.trim();
    if (!messageType) {
        setStatus({
            type: "error",
            text: "Please select a message type.",
        });
        return;
    }

    if (!user) {
      setStatus({
        type: "error",
        text: "Please sign in before sending feedback.",
      });
      return;
    }

    if (cleanMessage.length < 10) {
      setStatus({
        type: "error",
        text: "Please write a little more detail before sending.",
      });
      return;
    }

    if (cleanMessage.length > 2000) {
      setStatus({
        type: "error",
        text: "Please keep your message under 2,000 characters.",
      });
      return;
    }

    try {
      setIsSending(true);

      const functions = getFunctions(undefined, "us-west2");
      const submitSupportMessage = httpsCallable(
        functions,
        "submitSupportMessage"
      );

      await submitSupportMessage({
        type: messageType,
        typeLabel: selectedTypeLabel,
        message: cleanMessage,
        pageUrl: window.location.href,
        userAgent: navigator.userAgent,
      });

      setMessage("");
      setMessageType("");
      setStatus({
        type: "success",
        text: "Message sent. Thank you for helping improve Fútbol Fantasy.",
      });
    } catch (err) {
      console.error("Failed to send support message:", err);
      setStatus({
        type: "error",
        text:
          err?.message ||
          "Something went wrong while sending your message. Please try again.",
      });
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="support-page">
      <section className="support-hero">
       {/*<span className="support-beta-pill">BETA SUPPORT</span>*/}

        <h1>Help Keep Fútbol Fantasy Free</h1>

        <p>
          Your support helps cover
          server costs, API costs, testing, and future updates.
        </p>
      </section>

      <section className="support-grid">
        <article className="support-card support-card-featured">
          <div className="support-icon">
            <Heart size={28} />
          </div>

          <h2>Support the App</h2>

          <p>
            Every contribution helps keep the app running and improving without
            forcing users behind a paywall.
          </p>

          {stripeReady ? (
            <a
              className="support-main-btn"
              href={STRIPE_SUPPORT_LINK}
              target="_blank"
              rel="noreferrer"
            >
              <CreditCard size={18} />
              Support
            </a>
          ) : (
            <button className="support-main-btn support-main-btn-disabled" disabled>
              <CreditCard size={18} />
              Card Support Coming Soon
            </button>
          )}

          <p className="support-small-text">
            Donations are optional and processed securely through Stripe.
          </p>
        </article>

        <article className="support-card">
          <div className="support-icon">
            <MessageSquare size={28} />
          </div>

          <h2>Feedback & Bug Reports</h2>

          <p>
            Found a bug, have an idea, or want to leave a comment? Send it
            directly from here.
          </p>

          <form className="support-feedback-form" onSubmit={handleSubmitFeedback}>
            <label className="support-field">
              <span>Message Type</span>
              <div className="support-select-wrap">
                <select
                    value={messageType}
                    onChange={(e) => setMessageType(e.target.value)}
                    className={!messageType ? "support-select-placeholder" : ""}
                >
                    <option value="" disabled>
                    Select message type
                    </option>

                    {MESSAGE_TYPES.map((item) => (
                    <option key={item.value} value={item.value}>
                        {item.label}
                    </option>
                    ))}
                </select>
                </div>
            </label>

            <label className="support-field">
              <span>Your Message</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Tell us what happened, what page you were on, or what you would like to see added..."
                rows={7}
                maxLength={2000}
              />
            </label>

            <div className="support-form-footer">
              <span>{message.trim().length}/2000</span>

              {user ? (
                <span className="support-user-pill">
                  Sending as {user.displayName || user.email}
                </span>
              ) : (
                <span className="support-user-pill support-user-pill-warning">
                  Sign in required
                </span>
              )}
            </div>

            {status && (
              <div
                className={
                  status.type === "success"
                    ? "support-status support-status-success"
                    : "support-status support-status-error"
                }
              >
                {status.type === "success" ? (
                  <CheckCircle2 size={18} />
                ) : (
                  <AlertTriangle size={18} />
                )}
                {status.text}
              </div>
            )}

            <button
              className="support-secondary-btn support-send-btn"
              type="submit"
              disabled={isSending}
            >
              <Send size={18} />
              {isSending ? "Sending..." : "Send Message"}
            </button>
          </form>
        </article>
      </section>

      <section className="support-legal-section" aria-labelledby="legal-policies-title">
        <div className="support-legal-header">
          <h2 id="legal-policies-title">Legal &amp; Policies</h2>
          <p>Quick links for account, privacy, copyright, and policy information or contact <b>support.futbolfantasy@gmail.com</b></p>
        </div>

        <div className="support-legal-grid">
          {LEGAL_LINKS.map((item) => {
            const Icon = item.icon;

            return (
              <Link className="support-legal-card" to={item.to} key={item.to}>
                <span className="support-legal-icon">
                  <Icon size={22} />
                </span>
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.text}</small>
                </span>
              </Link>
            );
          })}
        </div>
      </section>
    </main>
  );
}
