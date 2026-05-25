import { Link } from "react-router-dom";
import "./LegalPage.css";

const LAST_UPDATED = "May 19, 2026";
const SUPPORT_EMAIL = "support.futbolfantasy@gmail.com";

export default function CopyrightPage() {
  return (
    <main className="legal-page">
      <div className="legal-shell">
        <Link className="legal-back-link" to="/support">
          Back to Support
        </Link>

        <article className="legal-card">
          <header className="legal-header">
            <span className="legal-kicker">Legal</span>
            <h1>Copyright Policy</h1>
            <p className="legal-updated">Last updated: {LAST_UPDATED}</p>
          </header>

          <div className="legal-content">
            <section className="legal-section">
              <h2>1. Overview</h2>
              <p>
                This Copyright Policy explains how Fútbol Fantasy handles
                copyright concerns, user-uploaded profile pictures, and requests
                to remove content that may infringe someone else's rights.
              </p>
              <p>
                Fútbol Fantasy is an independent fantasy soccer platform. Users
                may upload profile pictures and submit limited content such as
                display names, team names, room names, and support messages. Users
                are responsible for making sure they have the right to upload or
                submit the content they provide.
              </p>
            </section>

            <section className="legal-section">
              <h2>2. User-Uploaded Profile Pictures</h2>
              <p>
                Users may only upload profile pictures they own, created, or have
                permission to use. Do not upload copyrighted images, celebrity
                photos, team logos, league logos, player photos, artwork, or other
                content unless you have the legal right to use it.
              </p>
              <p>
                By uploading a profile picture, you give Fútbol Fantasy permission
                to store and display that image as needed to operate the site,
                including showing it to other users who are in the same fantasy
                room as you.
              </p>
            </section>

            <section className="legal-section">
              <h2>3. Content We May Remove</h2>
              <p>
                Fútbol Fantasy may remove, hide, disable, or restrict access to
                content that appears to violate copyright law, these Terms, another
                person's rights, or the rules of the site.
              </p>
              <p>
                This may include profile pictures, display names, team names, room
                names, support messages, or any other content submitted by users.
              </p>
            </section>

            <section className="legal-section">
              <h2>4. Reporting Copyright Concerns</h2>
              <p>
                If you believe content on Fútbol Fantasy infringes your copyright,
                you can report it by emailing{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> or by using
                the Support page if you have an account.
              </p>
              <p>
                Please include enough detail for us to find and review the content,
                such as the room name, user display name, screenshot, page, or other
                identifying information.
              </p>
            </section>

            <section className="legal-section">
              <h2>5. Information to Include</h2>
              <p>
                To help us review a copyright concern, please include as much of
                the following information as possible:
              </p>

              <ul className="legal-list">
                <li>Your full name or the name of the copyright owner.</li>
                <li>Your contact information.</li>
                <li>A description of the copyrighted work you believe was copied.</li>
                <li>
                  A description of where the content appears on Fútbol Fantasy,
                  such as the room name, user display name, page, screenshot, or
                  other identifying details.
                </li>
                <li>
                  A statement that you believe in good faith that the disputed use
                  is not authorized by the copyright owner, its agent, or the law.
                </li>
                <li>
                  A statement that the information in your request is accurate and
                  that you are the copyright owner or authorized to act on behalf
                  of the copyright owner.
                </li>
              </ul>
            </section>

            <section className="legal-section">
              <h2>6. What Happens After a Report</h2>
              <p>
                After receiving a copyright concern, Fútbol Fantasy may review the
                report, contact the user who uploaded the content, request more
                information, remove the content, disable access to the content, or
                take other action we believe is appropriate.
              </p>
              <p>
                We may not be able to resolve every dispute, determine ownership
                of every image, or provide legal advice. If there is a serious
                copyright dispute, the people involved may need to resolve it
                directly or through the proper legal process.
              </p>
            </section>

            <section className="legal-section">
              <h2>7. Repeat Infringers</h2>
              <p>
                Users who repeatedly upload or submit content that violates
                copyright rights, site rules, or another person's rights may have
                their content removed, profile image reset, account restricted, or
                access to Fútbol Fantasy suspended.
              </p>
            </section>

            <section className="legal-section">
              <h2>8. Counter-Notices</h2>
              <p>
                If your content was removed because of a copyright complaint and
                you believe the removal was a mistake, you may contact us through
                the Support page and explain why you believe you had the right to
                use the content.
              </p>
              <p>
                Include your account information, a description of the removed
                content, why you believe the removal was incorrect, and any
                permission or ownership information you want us to review.
              </p>
            </section>

            <section className="legal-section">
              <h2>9. No Affiliation With Sports Organizations</h2>
              <p>
                Fútbol Fantasy is not affiliated with, endorsed by, sponsored by,
                or officially connected to FIFA, UEFA, any league, club, team,
                player, federation, or official competition.
              </p>
              <p>
                Team names, player names, competition names, and other sports
                references may be used for identification and descriptive purposes
                only. Users should not upload team logos, league logos, official
                competition marks, copyrighted photos, or other protected content
                unless they have permission.
              </p>
            </section>

            <section className="legal-section">
              <h2>10. Copyright Contact</h2>
              <p>
                Copyright concerns can be sent to{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Users with
                an account may also contact us through the Support page.
              </p>
              <p>
                Fútbol Fantasy may add formal DMCA agent information in the future.
                If a designated agent is added, this page will be updated with the
                proper contact information and instructions.
              </p>
            </section>

            <div className="legal-support-note">
              <span>Need to contact us about copyright?</span>
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            </div>
          </div>
        </article>
      </div>
    </main>
  );
}