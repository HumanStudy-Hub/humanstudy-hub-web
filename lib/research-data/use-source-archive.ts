'use client';
import {useEffect,useState} from 'react';
import type {StudioSource} from '../studio/types';
import {useResearchCollectionEnabled} from './collection-context';
/** Operational private storage is durable; retry archival after remount or a failed request. */
export function useSourceArchive(workspace: string, sources: StudioSource[]) {
  const [error,setError]=useState('');
  const enabled=useResearchCollectionEnabled();
  const stamp=sources.map(s=>s.id+':'+s.path).join('|');
  useEffect(()=>{
    if(!enabled)return;
    const controller=new AbortController(); let retry:ReturnType<typeof setTimeout>|undefined;
    const pending=new Set(sources.map(s=>s.id));
    async function send(){
      for(const sourceId of [...pending]){
        if(controller.signal.aborted)return;
        try{const r=await fetch(`/api/studio/workspaces/${workspace}/research-source`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceId}),signal:controller.signal});if(r.ok)pending.delete(sourceId);else if(r.status===401||r.status===403){setError('Your source is saved. Sign in and review the agreement to finish research upload.');return;}}catch{if(controller.signal.aborted)return;}
      }
      if(!controller.signal.aborted)setError(pending.size?'Your source is saved. Research upload is waiting to retry.':'');
      if(pending.size&&!controller.signal.aborted)retry=setTimeout(()=>void send(),30000);
    }
    void send();return()=>{controller.abort();if(retry)clearTimeout(retry);};
  },[workspace,stamp,enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return error;
}
