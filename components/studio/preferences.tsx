"use client";
import { useEffect,useRef,useState,type CSSProperties } from 'react';
import s from './projects.module.css';
export type StudioPreferences={theme:'system'|'light'|'dark';fontScale:90|100|110;density:'comfortable'|'compact';sendMode:'enter'|'modifier'};
export const defaultPreferences:StudioPreferences={theme:'system',fontScale:100,density:'comfortable',sendMode:'enter'};
const key='humanstudy-preferences-v1',eventName='humanstudy-preferences';
export function useStudioPreferences(){
 const [preferences,setPreferences]=useState(defaultPreferences);
 useEffect(()=>{
  const load=()=>{try{const saved=JSON.parse(localStorage.getItem(key)||'{}');const theme=saved.theme||localStorage.getItem('build-study-theme');setPreferences({theme:['system','light','dark'].includes(theme)?theme:'system',fontScale:[90,100,110].includes(saved.fontScale)?saved.fontScale:100,density:saved.density==='compact'?'compact':'comfortable',sendMode:saved.sendMode==='modifier'?'modifier':'enter'});}catch{setPreferences(defaultPreferences);}};
  load();window.addEventListener(eventName,load);window.addEventListener('storage',load);return()=>{window.removeEventListener(eventName,load);window.removeEventListener('storage',load);};
 },[]);
 function update(value:StudioPreferences){
  localStorage.setItem(key,JSON.stringify(value));localStorage.setItem('build-study-theme',value.theme);setPreferences(value);window.dispatchEvent(new Event(eventName));
 }
 const style={'--text-sm':`${14*preferences.fontScale/100}px`,'--text-xs':`${12*preferences.fontScale/100}px`} as CSSProperties;
 return {preferences,update,style};
}
export function PreferenceFields({preferences,onChange}:{preferences:StudioPreferences;onChange:(value:StudioPreferences)=>void}){
 return <div className={s.preferenceFields}>
  <label>Appearance<select value={preferences.theme} onChange={e=>onChange({...preferences,theme:e.target.value as StudioPreferences['theme']})}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
  <label>Text size<select value={preferences.fontScale} onChange={e=>onChange({...preferences,fontScale:Number(e.target.value) as StudioPreferences['fontScale']})}><option value={90}>Small</option><option value={100}>Default</option><option value={110}>Large</option></select></label>
  <label>Density<select value={preferences.density} onChange={e=>onChange({...preferences,density:e.target.value as StudioPreferences['density']})}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
  <label>Send message with<select value={preferences.sendMode} onChange={e=>onChange({...preferences,sendMode:e.target.value as StudioPreferences['sendMode']})}><option value="enter">Enter</option><option value="modifier">⌘ / Ctrl + Enter</option></select></label>
  <button type="button" onClick={()=>onChange(defaultPreferences)}>Reset preferences</button>
 </div>;
}
export function SettingsDialog({onClose,preferences,onChange}:{onClose:()=>void;preferences:StudioPreferences;onChange:(value:StudioPreferences)=>void}){
 const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{ref.current?.showModal();},[]);
 return <dialog ref={ref} className={s.settings} aria-label="Settings" onClose={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><header><strong>Settings</strong><button onClick={onClose} aria-label="Close settings">×</button></header><PreferenceFields preferences={preferences} onChange={onChange}/><div className={s.shortcutList}><p><kbd>⌘ / Ctrl S</kbd>Save</p><p><kbd>⌘ / Ctrl B</kbd>Project explorer</p><p><kbd>⌘ / Ctrl P</kbd>Find a project</p><p><kbd>⌘ / Ctrl ⇧ P</kbd>Commands</p></div><p className={s.muted}>Workspace interactions and AI conversations are recorded for platform research.</p></dialog>;
}
