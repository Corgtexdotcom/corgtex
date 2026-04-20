"use client";

import { useState, useEffect } from "react";

const NAV_LINKS: { href: string; label: string }[] = [
  { href: "/about", label: "About" },
  { href: "/pricing", label: "Pricing" },
  { href: "/how-we-work", label: "How We Work" },
  { href: "/blog", label: "Blog" },
  { href: "/faq", label: "FAQ" },
];

const APP_URL = "https://app.corgtex.com";
const DEMO_URL = `${APP_URL}/demo`;
const LOGIN_URL = `${APP_URL}/login`;

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <>
      <nav
        className="navbar"
        style={scrolled ? { boxShadow: "0 1px 4px rgba(0,0,0,0.06)" } : undefined}
      >
        <div className="navbar-inner">
          <a href="/" className="navbar-logo">Corgtex</a>

          <ul className="navbar-links">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href}>{link.label}</a>
              </li>
            ))}
          </ul>

          <div className="navbar-cta">
            <a
              href={LOGIN_URL}
              className="navbar-login"
            >
              Log In
            </a>
            <a
              href={DEMO_URL}
              className="btn btn-secondary"
              target="_blank"
              rel="noopener noreferrer"
            >
              Access the Demo
            </a>
            <a
              href="https://calendar.app.google/jJd5yeSuDStVZm896"
              className="btn btn-primary"
              target="_blank"
              rel="noopener noreferrer"
            >
              Schedule a Briefing
            </a>
          </div>

          <button
            className="navbar-toggle"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            <span
              style={
                mobileOpen
                  ? { transform: "rotate(45deg) translateY(7px)" }
                  : undefined
              }
            />
            <span style={mobileOpen ? { opacity: 0 } : undefined} />
            <span
              style={
                mobileOpen
                  ? { transform: "rotate(-45deg) translateY(-7px)" }
                  : undefined
              }
            />
          </button>
        </div>
      </nav>

      <div className={`mobile-menu ${mobileOpen ? "open" : ""}`}>
        {NAV_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            onClick={() => setMobileOpen(false)}
          >
            {link.label}
          </a>
        ))}
        <a
          href={LOGIN_URL}
          onClick={() => setMobileOpen(false)}
        >
          Log In
        </a>
        <a
          href={DEMO_URL}
          className="btn btn-secondary"
          target="_blank"
          rel="noopener noreferrer"
        >
          Access the Demo
        </a>
        <a
          href="https://calendar.app.google/jJd5yeSuDStVZm896"
          className="btn btn-primary"
          target="_blank"
          rel="noopener noreferrer"
        >
          Schedule a Briefing
        </a>
      </div>
    </>
  );
}
