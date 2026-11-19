import Image from "next/image";
import styles from "./partner-logos.module.css";

export const collaborators = [
  { id: "ucsd", name: "University of California San Diego", logo: "ucsd.png", city: "San Diego, United States", lat: 32.8801, lon: -117.234 },
  { id: "unil", name: "University of Lausanne", logo: "unil.svg", city: "Lausanne, Switzerland", lat: 46.5197, lon: 6.6323 },
  { id: "cmu", name: "Carnegie Mellon University", logo: "cmu.svg", city: "Pittsburgh, United States", lat: 40.4433, lon: -79.9436 },
  { id: "hku", name: "The University of Hong Kong", logo: "hku.svg", city: "Hong Kong", lat: 22.283, lon: 114.1371 },
  { id: "irides", name: "IRIDeS, Tohoku University", logo: "irides.svg", city: "Sendai, Japan", lat: 38.2506, lon: 140.856 },
  { id: "stanford", name: "Stanford University", logo: "stanford.png", city: "Stanford, United States", lat: 37.4275, lon: -122.1697 },
  { id: "mit", name: "Massachusetts Institute of Technology", logo: "mit.svg", city: "Cambridge, United States", lat: 42.3601, lon: -71.0942 },
] as const;

function PartnerLogos({ duplicate = false }: { duplicate?: boolean }) {
  return (
    <ul className={styles.logos} aria-hidden={duplicate || undefined}>
      {collaborators.map(partner => (
        <li key={partner.name}>
          <div className={styles.mark}>
            <Image
              src={`/images/partners/${partner.logo}`}
              alt={duplicate ? "" : partner.name}
              width={170}
              height={50}
              loading="eager"
              unoptimized
              className={styles[partner.id]}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function PartnerUniversities({ label = "Partner universities" }: { label?: string }) {
  return (
    <div className={styles.viewport} id="partner-logo-list" role="region" aria-label={label}>
      <div className={styles.track}>
        <PartnerLogos />
        <PartnerLogos duplicate />
      </div>
    </div>
  );
}
