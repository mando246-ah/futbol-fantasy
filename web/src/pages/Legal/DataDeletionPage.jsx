import { Link } from "react-router-dom";
import "./LegalPage.css";

const LAST_UPDATED = "May 19, 2026";
const SUPPORT_EMAIL = "support.futbolfantasy@gmail.com";

export default function DataDeletionPage() {
  return (
    <main className="legal-page">
      <div className="legal-shell">
        <Link className="legal-back-link" to="/support">
          Back to Support
        </Link>

        <article className="legal-card">
          <header className="legal-header">
            <span className="legal-kicker">Legal</span>
            <h1>Data Deletion Request</h1>
            <p className="legal-updated">Last updated: {LAST_UPDATED}</p>
          </header>

          <div className="legal-content">
            <section className="legal-section">
              <h2>1. Overview</h2>
              <p>
                This page explains how users can request deletion or
                anonymization of account information connected to Fútbol Fantasy.
                Fútbol Fantasy is an independent fantasy soccer platform
                currently in beta.
              </p>
              <p>
                Because fantasy rooms include shared drafts, standings, matchups,
                tournament history, and results involving multiple users, some
                information may need to be anonymized instead of fully deleted so
                existing rooms and records do not break.
              </p>
            </section>

            <section className="legal-section">
              <h2>2. How to Request Deletion</h2>
              <p>
                You can request account deletion, profile picture removal, or
                data anonymization by emailing{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
                Users with an account may also send a request through the Support
                page.
              </p>
              <p>
                To help us find your account, please include the email address
                connected to your Fútbol Fantasy account. If possible, also
                include your display name, room code, or any other details that
                help identify the account or data you are asking about.
              </p>
            </section>

            <section className="legal-section">
              <h2>3. What You Can Request</h2>
              <p>You may request that Fútbol Fantasy:</p>

              <ul className="legal-list">
                <li>Delete or disable your account information where possible.</li>
                <li>Remove your uploaded profile picture.</li>
                <li>Remove or anonymize your display name.</li>
                <li>Anonymize your connection to old fantasy rooms where possible.</li>
                <li>Review support messages connected to your account.</li>
                <li>Answer privacy questions about information connected to your account.</li>
              </ul>
            </section>

            <section className="legal-section">
              <h2>4. What May Be Kept or Anonymized</h2>
              <p>
                Some Fútbol Fantasy data is connected to shared room history. For
                example, draft picks, matchups, standings, fantasy points, roster
                history, and tournament results may involve multiple users in the
                same room.
              </p>
              <p>
                If fully deleting your data would break an existing room,
                leaderboard, draft history, tournament result, or another user's
                gameplay record, Fútbol Fantasy may anonymize the data instead.
                This means your personal account details may be removed or
                replaced while the room history remains functional.
              </p>
            </section>

            <section className="legal-section">
              <h2>5. Information We May Need</h2>
              <p>
                Before processing a deletion request, we may need to verify that
                the request is connected to the correct account. We may ask for
                information such as:
              </p>

              <ul className="legal-list">
                <li>The email address used with Google Sign-In.</li>
                <li>Your Fútbol Fantasy display name.</li>
                <li>A room code or room name connected to your account.</li>
                <li>A short description of what you want deleted or anonymized.</li>
              </ul>
            </section>

            <section className="legal-section">
              <h2>6. Timing</h2>
              <p>
                Fútbol Fantasy will try to review deletion and anonymization
                requests within a reasonable time. Some requests may take longer
                if they involve shared rooms, tournament records, technical
                issues, backups, or account verification.
              </p>
              <p>
                If we need more information to complete the request, we may reply
                and ask for additional details.
              </p>
            </section>

            <section className="legal-section">
              <h2>7. Profile Pictures</h2>
              <p>
                If you request removal of your profile picture, Fútbol Fantasy
                will try to remove it from your profile and stop displaying it in
                rooms where possible. Some cached copies or backups may remain
                for a limited time depending on Firebase, browser caching, or
                technical storage systems.
              </p>
            </section>

            <section className="legal-section">
              <h2>8. Donations</h2>
              <p>
                Donation payments are processed by Stripe. If you made a donation,
                Fútbol Fantasy may not be able to delete records that Stripe or
                Fútbol Fantasy must keep for transaction, fraud prevention,
                accounting, tax, legal, or compliance reasons.
              </p>
              <p>
                Fútbol Fantasy does not store your full card number or security
                code.
              </p>
            </section>

            <section className="legal-section">
              <h2>9. Support Messages</h2>
              <p>
                If you sent a support message, we may keep some support records
                for bug tracking, abuse prevention, security, or site improvement.
                When possible, we may delete or anonymize support messages upon
                request.
              </p>
            </section>

            <section className="legal-section">
              <h2>10. Contact</h2>
              <p>
                Data deletion, privacy, and account requests can be sent to{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
                Users with an account may also use the Support page.
              </p>
            </section>

            <div className="legal-support-note">
              <span>Ready to request help?</span>
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            </div>
          </div>
        </article>
      </div>
    </main>
  );
}