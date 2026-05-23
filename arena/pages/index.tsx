import Link from 'next/link';
import Layout from '../components/Layout';

const STEPS = [
  {
    num: '01',
    icon: '₿',
    title: 'Get the BTC Signal',
    desc: 'A live BTC price round opens in the Arena. You decide: will BTC be above or below the target when the round closes?',
  },
  {
    num: '02',
    icon: '💰',
    title: 'Enter with Virtual USDC',
    desc: 'Each arena gives you a virtual bankroll. Stake it on your prediction — free trial arenas need no deposit.',
  },
  {
    num: '03',
    icon: '⚡',
    title: 'Round Resolves',
    desc: 'The round closes, the BTC outcome is verified on-chain, and winners are credited automatically.',
  },
  {
    num: '04',
    icon: '🏆',
    title: 'Collect Winnings',
    desc: 'Top players win real USDC. Winnings land in your in-bot balance instantly — withdraw to any Solana wallet anytime.',
  },
];

const FEATURES = [
  {
    icon: '🤖',
    title: 'Telegram-Native',
    desc: 'No app download. No sign-up form. Open Telegram, start the bot, and you\'re in the Arena.',
  },
  {
    icon: '🔗',
    title: 'Solana-Powered',
    desc: 'Every wallet, deposit, and withdrawal is settled on Solana. Fast, cheap, and verifiable.',
  },
  {
    icon: '₿',
    title: 'Live BTC Rounds',
    desc: 'Each round is a real-time BTC price prediction. Signal drops, window opens, round closes — repeat.',
  },
  {
    icon: '🤖',
    title: 'AI Opponents',
    desc: 'Free trial arenas fill with AI agents running live market signals — momentum, RSI, and odds drift.',
  },
  {
    icon: '⚙️',
    title: 'Automated Settlement',
    desc: 'Smart round monitoring and on-chain settlement means no manual payouts, ever.',
  },
  {
    icon: '🌍',
    title: 'NGN On-Ramp',
    desc: 'Fund your wallet with Nigerian Naira via bank transfer — no crypto exchange needed.',
  },
];

export default function Home() {
  return (
    <Layout>
      {/* Hero */}
      <section className="hero">
        <div className="container">
          <div className="hero-badge">⚡ Live on Telegram</div>
          <h1>
            Predict BTC.<br />
            <span className="highlight">Win Real USDC.</span>
          </h1>
          <p className="hero-sub">
            HeadlineOdds Arena is a Telegram-native BTC prediction league.
            Call the price direction, beat the crowd, and get paid on Solana.
          </p>
          <div className="hero-cta">
            <Link href="/play" className="btn btn-gold">
              🚀 Play on Telegram
            </Link>
            <a href="#how-it-works" className="btn btn-outline">
              How it works
            </a>
          </div>

          <div className="hero-stats">
            <div className="stat-item">
              <div className="stat-value">USDC</div>
              <div className="stat-label">Real payouts on Solana</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">~30s</div>
              <div className="stat-label">Withdrawal time</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">0 apps</div>
              <div className="stat-label">Just Telegram</div>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="section" id="how-it-works">
        <div className="container">
          <p className="section-label">How it works</p>
          <h2 className="section-title">Four steps to your first win</h2>
          <p className="section-sub">
            From zero to playing in under two minutes — no wallet setup, no exchange account.
          </p>
          <div className="steps">
            {STEPS.map((s) => (
              <div key={s.num} className="step-card">
                <div className="step-num">STEP {s.num}</div>
                <div className="step-icon">{s.icon}</div>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="section" id="features" style={{ paddingTop: 0 }}>
        <div className="container">
          <p className="section-label">Features</p>
          <h2 className="section-title">Built for real players</h2>
          <p className="section-sub">
            Everything you need to play, win, and withdraw — nothing you don't.
          </p>
          <div className="features-grid">
            {FEATURES.map((f) => (
              <div key={f.title} className="feature-card">
                <div className="feature-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <div className="cta-banner">
            <h2>Ready to enter the Arena?</h2>
            <p>
              Open the bot, fund your wallet, and make your first prediction in minutes.
            </p>
            <div className="cta-actions">
              <Link href="/play" className="btn btn-gold">
                🚀 Start Playing
              </Link>
              <a href="#how-it-works" className="btn btn-outline">
                Learn more
              </a>
            </div>
          </div>
        </div>
      </section>
    </Layout>
  );
}
