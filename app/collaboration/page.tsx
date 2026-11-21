import type { Metadata } from "next";
import Image from "next/image";
import CollaborationMap from "@/components/CollaborationMap";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Partnerships · HumanStudy-Hub" };

const team = [
  {
    name: "Xuan Liu",
    portrait: "xuan-liu",
    email: "xul049@ucsd.edu",
    website: "https://xuanl17.github.io/",
  },
  {
    name: "Haoyang Shang",
    portrait: "haoyang-shang",
    email: "hs5533@nyu.edu",
    website: "https://assassin808.github.io/",
  },
  {
    name: "Yuanjun Feng",
    portrait: "yuanjun-feng",
    email: "yuanjun.feng@unil.ch",
    website: "https://yuanjun-feng.github.io/",
  },
];

function TeamIcon({ kind }: { kind: "website" | "email" }) {
  const path = kind === "website"
    ? "M4 17c5 .8 9-2.5 13.4-12M9.7 6.4l8.1-2.1.8 8.3"
    : "M3 6.4l17.2-.9.8 12.6-17.4.8L3 6.4Zm1.1.7 7.8 5.6 7.5-6.4";
  return (
    <svg className={styles.inkIcon} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

export default function CollaborationPage() {
  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <h1>Research partnerships</h1>
        <div className={styles.invitation}>
          <p>We build AI tools for social science with researchers and institutions around the world.</p>
          <a href="mailto:xul049@ucsd.edu">Get in touch about a partnership</a>
        </div>
      </header>
      <section aria-labelledby="team-title">
        <h2 id="team-title">Meet the team</h2>
        <ul className={styles.team}>
          {team.map(member => (
            <li key={member.name}>
              <a className={styles.portrait} href={member.website} aria-label={`${member.name} — Personal website`}>
                <Image
                  src={`/images/team/${member.portrait}.webp`}
                  alt=""
                  width={320}
                  height={320}
                  unoptimized
                />
                <span className={styles.websiteTab}><TeamIcon kind="website" /></span>
              </a>
              <h3 className={styles.nameLine}>
                <a className={styles.name} href={member.website}>{member.name}</a>
                <a className={styles.email} href={`mailto:${member.email}`}
                  aria-label={`Email ${member.name} at ${member.email}`} title={member.email}>
                  <TeamIcon kind="email" />
                </a>
              </h3>
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.community} aria-labelledby="collaborators-title">
        <h2 id="collaborators-title">Collaborators</h2>
        <CollaborationMap />
      </section>
    </div>
  );
}
