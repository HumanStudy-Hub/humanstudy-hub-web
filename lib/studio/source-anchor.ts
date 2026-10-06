import type { Rect } from '@/app/build-preview/study-schema';

type Word = {t:string;x:number;y:number;w:number;h:number};
const normalized = (text:string) => text.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();

/** Locate a quoted passage in the rendered PDF's text runs. Never invent a box. */
export function quoteRects(words:Word[],quote:string):Rect[] {
 const needle=normalized(quote);
 if(!needle||!words.length)return [];
 const parts=words.map(word=>normalized(word.t));
 const haystack=parts.join(' '),start=haystack.indexOf(needle);
 // An ambiguous repeated passage needs a user selection, not an arbitrary highlight.
 if(start<0||haystack.indexOf(needle,start+1)>=0)return [];
 const end=start+needle.length;let offset=0;
 const boxes:Rect[]=[];
 parts.forEach((part,i)=>{const next=offset+part.length;if(next>start&&offset<end){const {x,y,w,h}=words[i];boxes.push({x,y,w:Math.min(w,100-x),h:Math.min(h,100-y)});}offset=next+1;});
 // Merge adjacent runs on the same line to keep the overlay compact.
 const result:Rect[]=[];
 for(const box of boxes){const previous=result[result.length-1];if(previous&&Math.abs(previous.y-box.y)<Math.min(previous.h,box.h)*.4&&box.x>=previous.x&&box.x<=previous.x+previous.w+2){previous.w=Math.max(previous.x+previous.w,box.x+box.w)-previous.x;previous.h=Math.max(previous.h,box.y+box.h-previous.y);}else result.push({...box});}
 return result.slice(0,64);
}

/** Map selection bounds to page coordinates, independent of zoom and scrolling. */
export function sourceRect(page:{left:number;top:number;width:number;height:number}, selection:{left:number;top:number;width:number;height:number}):Rect|null {
 if(page.width<=0||page.height<=0)return null;
 const left=Math.max(page.left,selection.left),top=Math.max(page.top,selection.top);
 const right=Math.min(page.left+page.width,selection.left+selection.width),bottom=Math.min(page.top+page.height,selection.top+selection.height);
 if(right<=left||bottom<=top)return null;
 return {x:(left-page.left)/page.width*100,y:(top-page.top)/page.height*100,w:(right-left)/page.width*100,h:(bottom-top)/page.height*100};
}
