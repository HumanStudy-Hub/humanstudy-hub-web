import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ResearchAgreement } from '@/components/studio/research-agreement';
export const metadata:Metadata={title:"Study workspace | HumanStudy-Hub",robots:{index:false,follow:false}};
export default function BuildLayout({children}:{children:ReactNode}){return <ResearchAgreement>{children}</ResearchAgreement>;}
