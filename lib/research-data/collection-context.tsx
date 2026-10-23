'use client';
import {createContext,useContext} from 'react';
export const ResearchCollectionContext=createContext(false);
export const useResearchCollectionEnabled=()=>useContext(ResearchCollectionContext);
