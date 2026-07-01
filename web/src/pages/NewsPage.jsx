import React, { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, CalendarDays, Newspaper } from "lucide-react";
import newsPosts from "../data/newsPosts";
import { markLatestNewsPostSeen } from "../utils/newsStatus";
import "./NewsPage.css";

function dateValue(date) {
  const parsed = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNewsDate(date) {
  const parsed = dateValue(date);
  if (!parsed) return date;

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

export default function NewsPage() {
  useEffect(() => {
    markLatestNewsPostSeen(newsPosts);
  }, []);

  const posts = useMemo(
    () => [...newsPosts].sort((a, b) => dateValue(b.date) - dateValue(a.date)),
    []
  );

  return (
    <main className="newsPage">
      <div className="newsBackdrop newsBackdrop--one" aria-hidden="true" />
      <div className="newsBackdrop newsBackdrop--two" aria-hidden="true" />

      <div className="newsShell">
        <Link className="newsBackLink" to="/">
          <ArrowLeft size={16} />
          Back home
        </Link>

        <header className="newsHero">
          <div className="newsHeroIcon" aria-hidden="true">
            <Newspaper size={26} />
          </div>
          <p className="newsEyebrow">FÚTBOL FANTASY BULLETIN</p>
          <h1>News &amp; Updates</h1>
          <p className="newsSubtitle">
            Follow the latest rule changes, beta updates, and new features.
          </p>
        </header>

        <section className="newsFeed" aria-label="Fútbol Fantasy updates">
          {posts.map((post) => (
            <article className="newsCard" key={post.id}>
              <div className="newsMeta">
                <span className="newsDate">
                  <CalendarDays size={15} />
                  <time dateTime={post.date}>{formatNewsDate(post.date)}</time>
                </span>
                <span className="newsTag">{post.tag}</span>
                {post.isNew ? <span className="newsNewPill">NEW</span> : null}
              </div>

              <h2>{post.title}</h2>
              <p className="newsSummary">{post.summary}</p>

              <div className="newsBody">
                {(post.body || []).map((paragraph, index) => (
                  <p key={`${post.id}-paragraph-${index}`}>{paragraph}</p>
                ))}
              {post.callout && (
                <div className="newsPostCallout">
                  <div className="newsPostCalloutTitle">{post.callout.title}</div>
                  <div className="newsPostCalloutText">{post.callout.text}</div>
                </div>
              )}
              </div>

              {post.bullets?.length ? (
                <ul className="newsBulletList">
                  {post.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </section>

        <footer className="newsFooter">
          <span>More updates will appear here as the beta evolves.</span>
          <Link to="/support">Questions or feedback? Visit Support.</Link>
        </footer>
      </div>
    </main>
  );
}
