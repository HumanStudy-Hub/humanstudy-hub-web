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
    website: "https://github.com/assassin808",
  },
  {
    name: "Yuanjun Feng",
    portrait: "yuanjun-feng",
    email: "yuanjun.feng@unil.ch",
    website: "https://yuanjun-feng.github.io/",
  },
];

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
              </a>
              <h3>
                <a className={styles.name} href={`mailto:${member.email}`}
                  aria-label={`Email ${member.name} at ${member.email}`} title={member.email}>
                  {member.name}
                </a>
              </h3>
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.community} aria-labelledby="collaborators-title">
        <h2 id="collaborators-title">Our research community</h2>
        <CollaborationMap />
      </section>
    </div>
  );
}
