const DEMO_URL = "https://app.corgtex.com/demo";

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <a href="/" className="navbar-logo">Corgtex</a>
            <p>
              Your governed AI workforce. See every agent, enforce your rules, know what it costs.
            </p>
          </div>

          <div className="footer-col">
            <h4>Product</h4>
            <ul>
              <li><a href={DEMO_URL} target="_blank" rel="noopener noreferrer">Live Demo</a></li>
              <li><a href="/pricing">Pricing</a></li>
              <li><a href="/faq">FAQ</a></li>
              <li><a href="/how-we-work">How We Work</a></li>
              <li><a href="/facts">Facts</a></li>
            </ul>
          </div>

          <div className="footer-col">
            <h4>Company</h4>
            <ul>
              <li><a href="/about">About</a></li>
              <li><a href="/blog">Blog</a></li>
              <li><a href="/updates">Updates</a></li>
              <li><a href="mailto:hello@corgtex.com">Contact</a></li>
            </ul>
          </div>

          <div className="footer-col">
            <h4>Legal</h4>
            <ul>
              <li><a href="/privacy">Privacy</a></li>
              <li><a href="/terms">Terms</a></li>
            </ul>
          </div>
        </div>

        <div className="footer-bottom">
          <span>&copy; {year} Corgtex. All rights reserved.</span>
          <span>The governed AI workforce platform.</span>
        </div>
      </div>
    </footer>
  );
}
