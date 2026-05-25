import { Link } from "react-router-dom";
import "./LegalPage.css";

const LAST_UPDATED = "May 19, 2026";
const SUPPORT_EMAIL = "support.futbolfantasy@gmail.com";

export default function TermsPage() {
  return (
    <main className="legal-page">
      <div className="legal-shell">
        <Link className="legal-back-link" to="/support">
          Back to Support
        </Link>

        <article className="legal-card">
          <header className="legal-header">
            <span className="legal-kicker">Legal</span>
            <h1>Terms of Service</h1>
            <p className="legal-updated">Last updated: {LAST_UPDATED}</p>
          </header>

          <div className="legal-content">
            <section className="legal-section">
              <h2>1. Agreement to These Terms</h2>
              <p>
                These Terms of Service explain the rules for using Fútbol Fantasy.
                By signing in, creating an account, joining a room, creating a
                room, uploading a profile picture, sending a support message, or
                otherwise using the site, you agree to these Terms and our{" "}
                <Link to="/privacy">Privacy Policy</Link>.
              </p>
              <p>
                If you do not agree to these Terms, do not use Fútbol Fantasy.
                Fútbol Fantasy is currently operated personally by the site owner
                and is not owned by a separate company or LLC at this time.
              </p>
            </section>

            <section className="legal-section">
              <h2>2. About Fútbol Fantasy</h2>
              <p>
                Fútbol Fantasy is an independent fantasy soccer platform that lets
                users create or join private rooms, draft players, manage lineups,
                follow scores, view standings, and compete with friends for
                entertainment purposes.
              </p>
              <p>
                Fútbol Fantasy is currently in beta. That means features, scoring,
                room formats, user interface elements, player pools, live updates,
                and rules may change as the app is tested and improved.
              </p>
            </section>

            <section className="legal-section">
              <h2>3. Eligibility</h2>
              <p>
                You must be at least 13 years old to use Fútbol Fantasy. If you
                are under 13, you may not create an account or use the site. If you
                are under the age of majority where you live, you should use the
                site only with permission from a parent or legal guardian.
              </p>
            </section>

            <section className="legal-section">
              <h2>4. Accounts and Sign-In</h2>
              <p>
                Fútbol Fantasy currently uses Google Sign-In for account access.
                You are responsible for keeping your Google account secure and for
                activity that happens through your account on Fútbol Fantasy.
              </p>
              <p>
                You agree not to impersonate another person, use another user's
                account without permission, attempt to access rooms you are not
                allowed to access, or interfere with the normal operation of the
                site.
              </p>
            </section>

            <section className="legal-section">
              <h2>5. Fantasy Rooms, Scores, and Beta Changes</h2>
              <p>
                Fantasy scores, player stats, fixture information, live match
                status, standings, and results may depend on third-party sports
                data, automated systems, and app logic. These items may be delayed,
                incomplete, incorrect, or later corrected.
              </p>
              <p>
                Because the site is in beta, Fútbol Fantasy may correct scores,
                update standings, change scoring rules, fix rooms, reset broken
                data, pause features, or adjust game logic when needed to keep the
                app working fairly.
              </p>
              <p>
                Fútbol Fantasy does not guarantee that every score, stat, player
                position, fixture, lineup lock, live timer, or leaderboard will be
                accurate at all times.
              </p>
            </section>
            

            <section className="legal-section">
              <h2>6. No Gambling, Betting, or Prizes</h2>
              <p>
                Fútbol Fantasy is for entertainment. The site does not offer
                betting, gambling, paid contests, cash prize pools, or real-money
                fantasy contests.
              </p>
              <p>
                You may not use Fútbol Fantasy to organize, advertise, or operate
                betting, gambling, paid entry contests, or cash prize competitions.
                Any private agreement made outside of Fútbol Fantasy is not
                created, managed, approved, or enforced by Fútbol Fantasy.
              </p>
            </section>

            <section className="legal-section">
              <h2>7. Donations</h2>
              <p>
                Fútbol Fantasy may allow users to make optional donations to help
                cover server costs, API costs, testing, and future updates.
                Donations are voluntary and do not provide a paid advantage,
                ownership interest, prize eligibility, or guaranteed access to any
                special feature.
              </p>
              <p>
                Donations are processed by Stripe. Fútbol Fantasy does not store
                your full card number or security code. Donation refunds may be
                handled at Fútbol Fantasy's discretion or as required by law.
              </p>
            </section>

            <section className="legal-section">
              <h2>8. User Content and Profile Pictures</h2>
              <p>
                Users may add content such as display names, team names, room
                names, support messages, and profile pictures. You are responsible
                for the content you provide.
              </p>
              <p>
                You may only upload profile pictures that you own, created, or have
                permission to use. Do not upload copyrighted images, illegal
                content, hateful content, sexually explicit content, abusive
                content, or anything that violates another person's rights.
              </p>
              <p>
                By uploading a profile picture or submitting content, you give
                Fútbol Fantasy permission to store, process, and display that
                content as needed to operate the site, including showing your
                profile picture to users who are in the same room as you.
              </p>
              <p>
                Fútbol Fantasy may remove content or restrict accounts if content
                appears to violate these Terms, the law, or the rights of another
                person.
              </p>
            </section>

            <section className="legal-section">
              <h2>9. Acceptable Use</h2>
              <p>You agree not to:</p>
              <ul className="legal-list">
                <li>Use the site for illegal activity, harassment, abuse, or threats.</li>
                <li>Upload content you do not have the right to use.</li>
                <li>Try to hack, overload, scrape, reverse engineer, or disrupt the site.</li>
                <li>Exploit bugs, automation, or hidden tools to gain an unfair advantage.</li>
                <li>Attempt to access another user's account, private room, data, or admin tools.</li>
                <li>Use Fútbol Fantasy to run gambling, betting, paid contests, or prize pools.</li>
                <li>Misrepresent Fútbol Fantasy as being official or affiliated with any league, club, player, or competition.</li>
              </ul>
            </section>

            <section className="legal-section">
              <h2>10. Sports Data and Third-Party Services</h2>
              <p>
                Fútbol Fantasy may use third-party services and data providers,
                including Google Sign-In, Firebase, Google Analytics, Stripe, and
                API-Football. These services may have their own terms and privacy
                practices.
              </p>
              <p>
                Sports data, including player names, team names, fixtures, match
                status, scores, and statistics, may come from third-party sources.
                This data is used for identification, scoring, and gameplay, but it
                may be delayed, incomplete, unavailable, corrected, or restricted.
              </p>
            </section>

            <section className="legal-section">
              <h2>11. Intellectual Property and No Affiliation</h2>
              <p>
                Fútbol Fantasy's name, site design, code, features, layout,
                graphics, text, and original content belong to Fútbol Fantasy or
                the site owner, unless stated otherwise.
              </p>
              <p>
                Team names, player names, competition names, and other sports
                references may be used for identification and descriptive purposes
                only. Fútbol Fantasy does not claim ownership of third-party names,
                trademarks, data, or rights.
              </p>
              <p>
                Fútbol Fantasy is an independent fantasy soccer platform. It is not
                affiliated with, endorsed by, sponsored by, or officially connected
                to FIFA, UEFA, any league, club, team, player, federation, or
                official competition.
              </p>
            </section>

            <section className="legal-section">
              <h2>12. Account Removal and Data Requests</h2>
              <p>
                You may request account deletion or data deletion through the{" "}
                <Link to="/data-deletion">Data Deletion Request</Link> page or the
                Support page.
              </p>
              <p>
                Because Fútbol Fantasy uses shared rooms, drafts, standings, and
                tournament history, some information may need to be anonymized
                instead of fully removed so that existing rooms and results do not
                break. More details are available in the{" "}
                <Link to="/privacy">Privacy Policy</Link>.
              </p>
            </section>

            <section className="legal-section">
              <h2>13. Suspension or Removal</h2>
              <p>
                Fútbol Fantasy may suspend, restrict, or remove access to accounts,
                rooms, content, or features if we believe a user has violated these
                Terms, created risk for other users, abused the service, uploaded
                improper content, or interfered with the site.
              </p>
            </section>

            <section className="legal-section">
              <h2>14. Service Availability and Disclaimers</h2>
              <p>
                Fútbol Fantasy is provided on an "as is" and "as available" basis.
                The site may experience bugs, downtime, incorrect scores, delayed
                live updates, missing data, or other issues, especially while in
                beta.
              </p>
              <p>
                To the fullest extent allowed by law, Fútbol Fantasy is not
                responsible for losses, damages, disputes, missed drafts, incorrect
                fantasy results, unavailable features, third-party data problems,
                or issues caused by services outside of Fútbol Fantasy's control.
              </p>
            </section>

            <section className="legal-section">
              <h2>15. Changes to These Terms</h2>
              <p>
                Fútbol Fantasy may update these Terms from time to time. When
                important changes are made, the "Last updated" date will be
                changed, and users may be asked to review and accept the updated
                Terms before continuing to use the site.
              </p>
              <p>
                Continuing to use Fútbol Fantasy after updated Terms are posted
                means you accept the updated Terms.
              </p>
            </section>

            <section className="legal-section">
              <h2>16. Service Notifications</h2>
              <p>
                By using Fútbol Fantasy, you understand that the site may send
                service-related email notifications connected to your rooms, drafts,
                and transfer markets. These may include scheduled draft reminders,
                draft starting soon reminders, scheduled market reminders, and market
                starting soon reminders.
              </p>
            </section>

            <section className="legal-section">
  <h2>16. Contact</h2>
  <p>
    Questions about these Terms can be sent by emailing{" "}
    <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Users with
    an account may also contact Fútbol Fantasy through the Support page.
  </p>
</section>

            <div className="legal-support-note">
              <span>Questions about these terms?</span>
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            </div>
          </div>
        </article>
      </div>
    </main>
  );
}