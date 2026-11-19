"use client";

import { Fragment, type ReactNode } from "react";
import usePreviewPlayback from "./usePreviewPlayback";
import SiteLogo from "@/components/SiteLogo";
import styles from "./desktop-preview.module.css";

type PanelProps = {
  name: string;
  className: string;
  run: number;
  children: ReactNode;
};

function PreviewPanel({ name, className, run, children }: PanelProps) {
  return (
    <section className={className} aria-label={name}>
      <Fragment key={run}>{children}</Fragment>
    </section>
  );
}

export default function DesktopPreview() {
  const { ref, playing, run, replay, onPointerEnter, onPointerLeave } = usePreviewPlayback();

  return (
    <figure ref={ref} className={styles.window} data-playing={playing ? run : undefined}
      onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onFocus={replay} tabIndex={0}>
      <figcaption className="sr-only">
        HumanStudy Desktop demonstration. A researcher asks about a hypothesis,
        the study agent finds it, and the matching passage lights up in the original paper.
      </figcaption>
      <div className={styles.titleBar}>
        <span className={styles.windowDots} aria-hidden="true"><i /><i /><i /></span>
        <span className={styles.appName}><SiteLogo />HumanStudy Desktop</span>
      </div>
      <div className={styles.workspace}>
        <PreviewPanel run={run} className={styles.chat} name="Study agent">
          <div className={styles.panelBar}>Study agent</div>
          <div className={styles.conversation}>
            <p className={styles.question}>Where is the first hypothesis in the paper?</p>
            <div className={styles.reply}>
              <span className={styles.agentName}><SiteLogo /> Study agent</span>
              <div className={styles.response}>
                <span className={styles.typing} aria-hidden="true">•••</span>
                <div className={styles.answer}>
                  <p>It’s on page 5. People who choose an option expect others to choose it too.</p>
                  <span className={styles.cite}>Paper · p. 5</span>
                </div>
              </div>
            </div>
          </div>
        </PreviewPanel>
        <PreviewPanel run={run} className={styles.study} name="Study materials">
          <div className={styles.panelBar}>
            <span className={styles.tab}>Study</span><span className={styles.otherTab}>Paper</span>
          </div>
          <div className={styles.document}>
            <h3>The false consensus effect</h3>
            <p className={styles.metadata}>Ross, Greene &amp; House · 1977</p>
            <h4>Paper overview</h4>
            <p>Four studies on how people estimate the popularity of their own choices.</p>
            <h4>Research questions &amp; hypotheses</h4>
            <div className={styles.finding}>
              <strong>Own choice and perceived consensus</strong>
              <span className={styles.ref}>Source · p. 5</span>
            </div>
            <h4>Questionnaire</h4>
            <p>Participants reported their own choice and estimated how many others would make the same one.</p>
          </div>
        </PreviewPanel>
        <PreviewPanel run={run} className={styles.source} name="Paper reader">
          <div className={styles.panelBar}>Original paper <span className={styles.pageNumber}>p. 5</span></div>
          <div className={styles.sheet}>
            <div className={styles.folio}><span>The false consensus effect</span><span>283</span></div>
            <p className={styles.passageIntro}>Summary of hypotheses.</p>
            <p className={styles.passage}>
              <mark onAnimationEnd={replay}>Subjects who “choose” a particular hypothetical response will rate that response as more probable for “people in general”</mark> than will subjects who “choose” the alternative response.
            </p>
            <div className={styles.tableExcerpt} role="img" aria-label="Original Table 1 comparing estimates of consensus across choices in Study 1." />
          </div>
        </PreviewPanel>
      </div>
    </figure>
  );
}
