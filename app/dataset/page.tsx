import { promises as fs } from "fs";
import path from "path";
import DatasetCatalog from "@/components/DatasetCatalog";

export default async function DatasetPage() {
  const raw = await fs.readFile(path.join(process.cwd(), "data/studies_index.json"), "utf8");
  const studies = JSON.parse(raw).studies ?? [];

  return (
    <div className="min-h-screen bg-[#f7f9fa]">
      <header className="bg-white">
        <div className="mx-auto max-w-7xl px-6 py-12 sm:px-8 sm:py-16">
          <p className="text-xs font-bold uppercase text-cyan-800">Open study materials</p>
          <h1 className="mt-3 font-serif text-4xl font-bold text-gray-950">Datasets</h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-gray-600">The initial test suite contains reconstructed studies with complete materials. Community datasets extend the collection across social-science fields.</p>
        </div>
      </header>
      <DatasetCatalog studies={studies} />
    </div>
  );
}
