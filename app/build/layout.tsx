import type { Metadata } from 'next';
import type { ReactNode } from 'react';
export const metadata:Metadata={title:'Build Study · Human Study Hub',robots:{index:false,follow:false}};
export default function BuildLayout({children}:{children:ReactNode}){return children;}
