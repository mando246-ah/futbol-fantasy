import { Link } from "react-router-dom";
import "./LegalPage.css";

const LAST_UPDATED = "May 19, 2026";
const SUPPORT_EMAIL = "support.futbolfantasy@gmail.com";

export default function PrivacyPage() {
  return (
    <main className="legal-page">
      <div className="legal-shell">
        <Link className="legal-back-link" to="/support">
          Back to Support
        </Link>

        <article className="legal-card">
          <header className="legal-header">
            <span className="legal-kicker">Legal</span>
            <h1>Privacy Policy</h1>
            <p className="legal-updated">Last updated: {LAST_UPDATED}</p>
          </header>

          <div className="legal-content">
            <section className="legal-section">
              <h2>1. Overview</h2>
              <p>
                This Privacy Policy explains how Fútbol Fantasy collects, uses,
                stores, and protects information when you use the site. Fútbol
                Fantasy is an independent fantasy soccer platform currently in
                beta and operated personally by the site owner.
              </p>
              <p>
                By using Fútbol Fantasy, signing in, creating or joining a room,
                uploading a profile picture, sending a support message, or making
                a donation, you agree to this Privacy Policy.
              </p>
            </section>

            <section className="legal-section">
              <h2>2. Information We Collect</h2>
              <p>
                Fútbol Fantasy may collect information you provide directly,
                information created through gameplay, and limited technical or
                analytics information.
              </p>

              <ul className="legal-list">
                <li>
                  <strong>Account information:</strong> When you sign in with
                  Google, we may receive your name, email address, Google account
                  identifier, and profile photo if available. We may use your email
                  address to send important service notifications related to your
                  fantasy rooms, drafts, and transfer markets.
                </li>
                <li>
                  <strong>Profile information:</strong> This may include your
                  display name, profile picture, and other profile details you add
                  to your account.
                </li>
                <li>
                  <strong>Fantasy gameplay data:</strong> This may include rooms,
                  room codes, room membership, draft picks, rosters, lineups,
                  bench players, team names, fantasy scores, standings, matchups,
                  tournament history, and related game activity.
                </li>
                <li>
                  <strong>Uploaded profile pictures:</strong> If you upload a
                  profile picture, we store and display it as needed for your
                  account and rooms.
                </li>
                <li>
                  <strong>Support messages:</strong> If you send feedback, bug
                  reports, questions, or other messages through the Support page,
                  we collect the message type, message content, page URL, user
                  agent, and account information connected to the signed-in user.
                </li>
                <li>
                  <strong>Analytics information:</strong> We may collect page
                  views, route changes, sign-in events, device/browser
                  information, approximate location based on technical signals,
                  and other usage information through Google Analytics.
                </li>
                <li>
                  <strong>Donation information:</strong> If you choose to support
                  the app through Stripe, Stripe processes the donation. We may
                  receive limited transaction information such as donation amount,
                  date, status, and contact details if provided, but Fútbol
                  Fantasy does not store your full card number or security code.
                </li>
              </ul>
            </section>

            <section className="legal-section">
              <h2>3. How We Use Information</h2>
              <p>We use information to operate, improve, and protect the site.</p>

              <ul className="legal-list">
                <li>To let users sign in and access their account.</li>
                <li>To create, join, manage, and display fantasy rooms.</li>
                <li>To run drafts, rosters, lineups, standings, and scoring.</li>
                <li>To show profile pictures to users in the same room.</li>
                <li>To debug issues, fix bugs, and improve beta features.</li>
                <li>To respond to support messages and feedback.</li>
                <li>To understand site usage and performance through analytics.</li>
                <li>To help prevent abuse, cheating, unauthorized access, or security issues.</li>
                <li>To process optional donations through Stripe.</li>
                <li>To comply with legal obligations and enforce our Terms of Service.</li>
                <li>To send service notifications about scheduled drafts and transfer markets.</li>
              </ul>
            </section>

            <section className="legal-section">
              <h2>4. Google Sign-In</h2>
              <p>
                Fútbol Fantasy uses Google Sign-In so users can create and access
                accounts. When you sign in with Google, we may receive basic
                account information such as your name, email address, Google user
                ID, and profile photo if available.
              </p>
              <p>
                We use this information to identify your account, show your
                profile, connect you to your rooms, and protect your account
                access. We do not use your Google account information to sell ads,
                sell user data, or operate betting/gambling features.
              </p>
            </section>
            

            <section className="legal-section">
              <h2>5. Firebase and Data Storage</h2>
              <p>
                Fútbol Fantasy uses Firebase and Google Cloud services to support
                authentication, database storage, profile images, backend
                functions, hosting, analytics, and other app features.
              </p>
              <p>
                This means account data, fantasy room data, profile information,
                support messages, uploaded profile pictures, and related app data
                may be stored or processed using Firebase or Google Cloud
                services.
              </p>
            </section>

            <section className="legal-section">
              <h2>6. Google Analytics</h2>
              <p>
                Fútbol Fantasy uses Google Analytics to understand how people use
                the site, which pages are visited, how the app performs, and where
                users may be running into issues.
              </p>
              <p>
                Google Analytics may use cookies, device identifiers, browser
                information, page view data, event data, approximate location, and
                similar technologies to provide analytics information.
              </p>
              <p>
                We do not currently show ads, sell user data, or use the site for
                advertising-based contests. If we later add ads, remarketing,
                advertising personalization, or similar features, we will update
                this Privacy Policy.
              </p>
            </section>

            <section className="legal-section">
              <h2>7. Stripe Donations</h2>
              <p>
                Fútbol Fantasy may allow optional donations through Stripe to help
                cover server costs, API costs, testing, and future updates.
                Donations are voluntary and are not required to use the app.
              </p>
              <p>
                Stripe processes donation payments. Fútbol Fantasy does not store
                your full card number or security code. Stripe may provide us with
                limited donation information such as donation amount, date,
                payment status, and contact details if you provide them during the
                donation process.
              </p>
            </section>

            <section className="legal-section">
              <h2>8. API-Football and Sports Data</h2>
              <p>
                Fútbol Fantasy uses API-Football and/or related sports data
                services to retrieve soccer data such as players, teams,
                competitions, fixtures, match status, scores, and player stats.
              </p>
              <p>
                This sports data is used to power fantasy drafts, live scoring,
                lineups, standings, tournament history, and other gameplay
                features. Normal sports data requests do not require API-Football
                to receive your Google account information.
              </p>
            </section>

            <section className="legal-section">
              <h2>9. Profile Pictures and Visibility</h2>
              <p>
                If you upload a profile picture, it may be visible to other users
                who are in the same room as you. Your profile picture may appear
                in room pages, draft pages, roster pages, tournament pages,
                standings, and related fantasy gameplay areas.
              </p>
              <p>
                You should only upload images you own or have permission to use.
                Do not upload copyrighted, illegal, abusive, hateful, explicit, or
                harmful images.
              </p>
            </section>

            <section className="legal-section">
              <h2>10. When We Share Information</h2>
              <p>
                We do not sell user data. We do not currently run ads. We do not
                share personal information with advertisers for cross-site ad
                targeting.
              </p>
              <p>
                We may share or process information through service providers that
                help operate the site, including Google Sign-In, Firebase, Google
                Analytics, Stripe, hosting providers, and sports data providers.
              </p>
              <p>
                We may also disclose information if required by law, to protect
                users, to investigate abuse or security issues, to enforce our
                Terms of Service, or to respond to valid legal requests.
              </p>
            </section>

            <section className="legal-section">
              <h2>11. Cookies and Similar Technologies</h2>
              <p>
                Fútbol Fantasy and its service providers may use cookies, local
                storage, device identifiers, or similar technologies to keep users
                signed in, remember user preferences, support analytics, improve
                site performance, and protect the app.
              </p>
              <p>
                You may be able to limit cookies or tracking through your browser
                settings, device settings, Google account settings, or analytics
                opt-out tools. Some features may not work correctly if cookies or
                local storage are disabled.
              </p>
            </section>

            <section className="legal-section">
              <h2>12. Data Retention</h2>
              <p>
                We keep information for as long as needed to operate Fútbol
                Fantasy, maintain fantasy rooms and tournament history, provide
                support, improve the app, prevent abuse, comply with legal
                obligations, and resolve disputes.
              </p>
              <p>
                Because fantasy rooms contain shared drafts, standings, matchups,
                and history involving multiple users, some data may need to remain
                in anonymized form even after an account deletion request so that
                existing rooms and results do not break.
              </p>
            </section>

            <section className="legal-section">
              <h2>13. Data Deletion and Account Requests</h2>
              <p>
                You may request deletion of your account information through the{" "}
                <Link to="/data-deletion">Data Deletion Request</Link> page, the
                Support page, or by emailing{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
              </p>
              <p>
                When possible, we may delete account information, profile details,
                and uploaded profile pictures. In some cases, we may anonymize
                information instead of fully deleting it, especially when deletion
                would break existing rooms, standings, tournament records, draft
                history, or other users' gameplay records.
              </p>
            </section>

            <section className="legal-section">
              <h2>14. Security</h2>
              <p>
                We use reasonable technical and organizational measures to protect
                Fútbol Fantasy and user information. However, no website, database,
                server, or internet transmission is completely secure.
              </p>
              <p>
                You are responsible for keeping your Google account secure and for
                signing out on shared devices.
              </p>
            </section>

            <section className="legal-section">
              <h2>15. Children</h2>
              <p>
                Fútbol Fantasy is not intended for children under 13. Users under
                13 may not create an account or use the site.
              </p>
              <p>
                If we learn that we collected personal information from a child
                under 13, we will take reasonable steps to delete or disable that
                information.
              </p>
            </section>

            <section className="legal-section">
              <h2>16. International Users</h2>
              <p>
                Fútbol Fantasy is currently written in English, but users from
                different countries may access the site. If you use Fútbol Fantasy
                from outside the United States, your information may be processed
                in the United States or other locations where our service
                providers operate.
              </p>
            </section>

            <section className="legal-section">
              <h2>17. Changes to This Privacy Policy</h2>
              <p>
                We may update this Privacy Policy as Fútbol Fantasy grows,
                especially if we add new features, new analytics tools, paid
                features, public contact methods, ads, or new third-party
                services.
              </p>
              <p>
                When important changes are made, we will update the "Last
                updated" date. We may also ask users to review and accept updated
                terms or privacy notices before continuing to use the site.
              </p>
            </section>

            <section className="legal-section">
            <h2>18. Email Notifications</h2>
              <p>
                Fútbol Fantasy may send service-related email notifications to the
                email address connected to your account. These emails may include
                reminders when a draft is scheduled, when a draft is starting soon,
                when a transfer market is scheduled, and when a transfer market is
                starting soon.
              </p>
              <p>
                These emails are used to help users manage their fantasy rooms and
                are not promotional marketing emails. As Fútbol Fantasy grows, we may
                add account settings that let users control certain notification
                preferences.
              </p>
            </section>

            <section className="legal-section">
              <h2>19. Contact</h2>
              <p>
                Privacy questions, data deletion requests, account-related requests,
                and legal questions can be sent by emailing{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Users with
                an account may also contact Fútbol Fantasy through the Support page.
              </p>
            </section>

            <div className="legal-support-note">
              <span>Need help with privacy questions?</span>
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            </div>
          </div>
        </article>
      </div>
    </main>
  );
}