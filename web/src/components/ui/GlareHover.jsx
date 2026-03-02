import React, { useState, useEffect } from 'react';
import './GlareHover.css';

const GlareHover = ({
  width = '100%',
  height = '100%',
  background = 'transparent',
  borderRadius = '10px',
  borderColor = 'transparent',
  children,
  glareColor = '#ffffff',
  glareOpacity = 0.5,
  glareAngle = -45,
  glareSize = 250,
  transitionDuration = 650,
  playOnce = false,
  autoPlay = false,           // <-- NEW PROP
  autoPlayInterval = 3000,    // <-- NEW PROP (3 seconds)
  className = '',
  style = {}
}) => {
  const hex = glareColor.replace('#', '');
  let rgba = glareColor;
  if (/^[0-9A-Fa-f]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    rgba = `rgba(${r}, ${g}, ${b}, ${glareOpacity})`;
  } else if (/^[0-9A-Fa-f]{3}$/.test(hex)) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    rgba = `rgba(${r}, ${g}, ${b}, ${glareOpacity})`;
  }

  // --- NEW: Auto-play timer logic ---
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    if (!autoPlay) return;

    const triggerGlare = () => {
      setIsActive(true);
      // Turn off the glare class after the animation completes
      // so it can reset its position for the next interval
      setTimeout(() => setIsActive(false), transitionDuration);
    };

    // Initial delay so it doesn't fire the millisecond the page loads
    const initialTimeout = setTimeout(triggerGlare, 1000);

    // Set up the repeating interval
    const interval = setInterval(triggerGlare, autoPlayInterval);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
    };
  }, [autoPlay, autoPlayInterval, transitionDuration]);

  const vars = {
    '--gh-width': width,
    '--gh-height': height,
    '--gh-bg': background,
    '--gh-br': borderRadius,
    '--gh-angle': `${glareAngle}deg`,
    '--gh-duration': `${transitionDuration}ms`,
    '--gh-size': `${glareSize}%`,
    '--gh-rgba': rgba,
    '--gh-border': borderColor
  };

  return (
    <div
      className={`glare-hover ${playOnce ? 'glare-hover--play-once' : ''} ${isActive ? 'glare-hover--active' : ''} ${className}`}
      style={{ ...vars, ...style }}
    >
      {children}
    </div>
  );
};

export default GlareHover;