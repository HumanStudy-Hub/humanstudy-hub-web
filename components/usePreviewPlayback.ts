"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";

export default function usePreviewPlayback() {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [run, setRun] = useState(1);
  const playing = motionAllowed && (visible || hovered);
  const replay = () => setRun(value => value + 1);

  useEffect(() => {
    const element = ref.current;
    if (!element || !("IntersectionObserver" in window)) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMotionAllowed(!motion.matches && !document.hidden);
    sync();
    motion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.intersectionRatio >= .25);
      if (!entry.isIntersecting) setHovered(false);
    }, { threshold: [0, .25] });
    observer.observe(element);
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  function onPointerEnter(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    setHovered(true);
    replay();
  }

  return { ref, playing, run, replay, onPointerEnter, onPointerLeave: () => setHovered(false) };
}
