"use client";

export function useT() { return (text:string)=>text; }
export function HubMark({size=26}:{size?:number}) { return <svg width={size} height={size} viewBox="0 0 32 32" fill="var(--accent,#247c91)" aria-hidden="true"><path d="M5 4h6v9h7l-3 6h-4v9H5V4Zm16 0h6v24h-6v-9h-4l3-6h1V4Z"/></svg>; }
export function UiIcon({name,size=16}:{name:"history"|"new"|"settings"|"panel"|"source"|"circle"|"selection";size?:number}) {
 const paths={
  history:<><path d="M3 9a7 7 0 1 1 1 8M3 4v5h5"/><path d="M12 8v4l3 2"/></>,
  new:<><path d="M12 5v14M5 12h14"/></>,
  settings:<><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="var(--surface,#fff)"/><circle cx="15" cy="17" r="2" fill="var(--surface,#fff)"/></>,
  panel:<><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>,
  source:<><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z"/><path d="M14 3v5h5M9 12h6M9 16h6"/></>,
  circle:<path d="M19 6c-4-4-12-3-15 2s-1 11 5 12 12-3 12-8c0-3-2-5-5-6"/>,
  selection:<><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/><path d="M8 12h8"/></>
 };
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
