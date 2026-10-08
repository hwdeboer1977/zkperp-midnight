// SPDX-License-Identifier: Apache-2.0

import { NavLink, Route, Routes } from "react-router-dom";
import { useConfig, useLedger, useNow } from "./lib/hooks";
import { fmt6 } from "./lib/bytes";
import { WalletButton } from "./components/WalletButton";
import { Logo } from "./components/Market";
import PublicPage from "./pages/Public";
import TradePage from "./pages/Trade";
import PortfolioPage from "./pages/Portfolio";
import LiquidityPage from "./pages/Liquidity";
import FaucetPage from "./pages/Faucet";

function PriceTicker() {
  const { ledger } = useLedger();
  const now = useNow(5000);
  if (!ledger) return null;
  const age = now - Number(ledger.priceTime);
  const stale = age >= Number(ledger.maxPriceAge);
  return (
    <span className={`ticker ${stale ? "bad" : ""}`} title={`price published ${age}s ago; limit ${ledger.maxPriceAge}s`}>
      <span className="pair">ETH-USD · {Math.floor(age / 60)}m ago</span>
      <span className="price">${fmt6(ledger.markPrice)}</span>
    </span>
  );
}

function StaleBanner() {
  const { ledger, error } = useLedger();
  const now = useNow(5000);
  if (error) return <div className="banner bad">Cannot read zkperp: {error}</div>;
  if (!ledger) return null;
  const age = now - Number(ledger.priceTime);
  if (age < Number(ledger.maxPriceAge)) return null;
  return (
    <div className="banner bad">
      The oracle price is {Math.floor(age / 60)} minutes old, past its {Math.floor(Number(ledger.maxPriceAge) / 60)}-minute
      limit. Trading — closes included — waits for the next price. Is the relayer running?
    </div>
  );
}

export default function App() {
  const config = useConfig();
  return (
    <>
      <header>
        <NavLink to="/" className="brand" end>
          <Logo />
          <span>
            <span className="name">
              zk<b>perp</b>
            </span>
            <span className="tag">Private perpetuals</span>
          </span>
        </NavLink>
        {config && <span className="net">{config.network.networkId}</span>}
        <nav>
          <NavLink to="/" end>
            Public
          </NavLink>
          <NavLink to="/trade">Trade</NavLink>
          <NavLink to="/portfolio">Portfolio</NavLink>
          <NavLink to="/liquidity">Liquidity</NavLink>
          <NavLink to="/faucet">Faucet</NavLink>
        </nav>
        <PriceTicker />
        <WalletButton />
      </header>
      <StaleBanner />
      <main>
        <Routes>
          <Route path="/" element={<PublicPage />} />
          <Route path="/trade" element={<TradePage />} />
          <Route path="/portfolio" element={<PortfolioPage />} />
          <Route path="/liquidity" element={<LiquidityPage />} />
          <Route path="/faucet" element={<FaucetPage />} />
        </Routes>
      </main>
    </>
  );
}
