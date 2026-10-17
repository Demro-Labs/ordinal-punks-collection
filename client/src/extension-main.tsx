import { createRoot } from "react-dom/client";
import { OrdiWallet } from "@/components/OrdiWallet";
import "./index.css";
import "./extension.css";

function ExtensionPopup() {
  return <main className="extension-shell">
    <header className="extension-header">
      <img src="./assets/brand/ordi-wallet.png" alt="" />
      <div><h1>Ordi Wallet</h1><p>Local vault · Bitcoin · Fractal</p></div>
    </header>
    <p className="extension-intro">Create or import your encrypted vault to view live balances, protocol assets, and the reviewed local PSBT signer. Import is available before connecting any website wallet.</p>
    <OrdiWallet site="pokedex" />
    <p className="extension-note">Preview build for desktop browsers. The vault is stored in this extension only and is not automatically shared with website-origin vaults.</p>
  </main>;
}

createRoot(document.getElementById("root")!).render(<ExtensionPopup />);
