"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import usePreviewPlayback from "./usePreviewPlayback";
import styles from "./research-scene.module.css";

export default function ResearchScene() {
  const { ref, playing, run, replay, onPointerEnter, onPointerLeave } = usePreviewPlayback();
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!playing || !element) return;
    let cancelled = false;
    let timer: number;
    function join() {
      setJoined(true);
      timer = window.setTimeout(() => {
        setJoined(false);
        timer = window.setTimeout(join, 4200);
      }, 3200);
    }
    Promise.all(Array.from(element.querySelectorAll("img"), image => image.decode()))
      .then(() => {
        if (!cancelled) timer = window.setTimeout(join, run === 1 ? 350 : 0);
      })
      .catch(() => { /* Keep the available still artwork if an image fails to load. */ });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [playing, ref, run]);

  return (
    <figure ref={ref} className={styles.scene} role="img" tabIndex={0}
      aria-label="Scientists exploring study data" data-together={playing && joined}
      onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onFocus={replay}>
      <span className={styles.cast}>
        <Image src="/images/scene/scientists.webp" alt="" width={624} height={550} loading="eager" />
      </span>
      <span className={styles.data}>
        <Image src="/images/scene/data.webp" alt="" width={766} height={464} loading="eager" />
      </span>
      <span className={styles.together}>
        <Image src="/images/scene/together.webp" alt="" width={1100} height={709} loading="eager" />
      </span>
    </figure>
  );
}
