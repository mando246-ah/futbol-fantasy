import React from "react";
import { useNavigate } from "react-router-dom";
import HyperSpeed from "../components/backgrounds/HyperSpeed"; // adjust path if needed
import "./Home.css";
import logo from "../assets/logo.png";

export default function Home() {
  const navigate = useNavigate();

  const handleLearnMore = () => {
    const el = document.getElementById("learn-more");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="homePage">
      {/* HERO (full screen) */}
      <section className="homeHero homeHeroFullBleed">
        {/* Background */}
        <div className="homeHeroBg" aria-hidden="true">
          <HyperSpeed />
          {/* Optional dark overlay for readability */}
          <div className="homeHeroOverlay" />
        </div>

        {/* Foreground content */}
        <div className="homeHeroContent">
          <div className="homeHeroInner">
            <img src={logo} alt="Fútball Fantasy Logo" className="homeHeroLogo" />
            <p className="homeKicker"></p>

            <h1 className="homeTitle">
              Bragging Rights Start Here
            </h1>

            <p className="homeSubtitle">
              Draft your squad. <span className="homeSubtitleAccent">Take the win</span>. Every week matters.
            </p>

            <div className="homeButtons">
              <button
                className="homeBtn homeBtnPrimary"
                onClick={() => navigate("/draft")}
              >
                Get Drafting
              </button>

              <button
                className="homeBtn homeBtnGhost"
                onClick={handleLearnMore}
              >
                How It Works
              </button>
            </div>

            <p className="homeMicro">
            </p>
          </div>
        </div>
      </section>

      {/* LEARN MORE SECTION */}
      <section id="learn-more" className="homeSection">
        <div className="homeSectionInner">
          <h2 className="homeSectionTitle">What is Fútball Fantasy?</h2>
          <p className="homeSectionText">
            Create a room, invite your friends, draft your squads, and compete weekly.
            Only your Starting XI scores — every pick matters.
          </p>

          <div className="homeFeatureGrid">
            <div className="homeFeatureCard">
              <h3>Live Draft Rooms</h3>
              <p>Join a room, draft in order, and build your squad in real time.</p>
            </div>

            <div className="homeFeatureCard">
              <h3>Lineups &amp; Subs</h3>
              <p>Set your starting XI and bench. — strategy wins.</p>
            </div>

            <div className="homeFeatureCard">
              <h3>Weekly Matchups</h3>
              <p>Head-to-head scoring weeks with standings and tie-breakers.</p>
            </div>
          </div>

          <div className="homeSectionCtaRow">
            <button
              className="homeBtn homeBtnPrimary"
              onClick={() => navigate("/draft")}
            >
              Start Drafting
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
