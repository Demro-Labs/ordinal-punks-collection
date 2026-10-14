import { isMobileUniSatDevice } from "@/lib/mobile-context";
import { buildUniSatOpenDappUrl, type UniSatDappSite } from "@/lib/unisat-mobile-dapp";

export function UniSatMobileOpenDappLink({
  site,
  walletMethodAvailable,
  methodLabel,
}: {
  site: UniSatDappSite;
  walletMethodAvailable: boolean;
  methodLabel: string;
}) {
  if (!isMobileUniSatDevice() || walletMethodAvailable) return null;

  let href: string;
  try {
    href = buildUniSatOpenDappUrl(window.location.href, site);
  } catch {
    return <p className="mt-3 border border-[#d99a54]/40 bg-[#10151a] p-3 font-mono text-[10px] leading-5 text-[#f2bd63]" role="status">Ouvrez ce site dans le navigateur intégré UniSat Mobile pour utiliser {methodLabel}.</p>;
  }

  return (
    <div className="mt-3 border border-[#d99a54]/40 bg-[#10151a] p-3 font-mono text-[10px] leading-5 text-[#f2bd63]" role="note">
      <p>Le provider UniSat Mobile ({methodLabel}) n’est pas disponible dans ce navigateur.</p>
      <a className="mt-2 inline-flex min-h-10 items-center border border-[#d99a54] px-3 py-2 text-[#f3efe5] underline" href={href}>
        Ouvrir ce site dans UniSat Mobile
      </a>
    </div>
  );
}
