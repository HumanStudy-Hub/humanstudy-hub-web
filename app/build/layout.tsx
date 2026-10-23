import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ResearchAgreement } from '@/components/studio/research-agreement';
export const metadata:Metadata={title:"Study workspace | HumanStudy-Hub",robots:{index:false,follow:false}};
export default function BuildLayout({children}:{children:ReactNode}){return <ResearchAgreement collection={process.env.RESEARCH_COLLECTION_V1_ENABLED==='1'}>{children}</ResearchAgreement>;}
