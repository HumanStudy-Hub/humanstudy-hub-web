"use client";
import s from './studio.module.css';

export default function WorkspaceRecovery(){
 return <div className={s.home} translate="no"><div data-workspace-content><section className={s.setup} role="alert"><h1>The workspace needs to reload.</h1><p>A display error interrupted this view. Your last saved study and conversations will be restored.</p><button onClick={()=>window.location.reload()}>Reload workspace</button></section></div></div>;
}
