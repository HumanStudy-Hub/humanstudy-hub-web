import StudioEditor from "@/components/studio/editor";
export default async function BuildWorkspacePage({params}:{params:Promise<{id:string}>}){const {id}=await params;return <StudioEditor id={id}/>;}
