import DatasetCatalog from "@/components/DatasetCatalog";
import { getStudies } from "@/lib/studies";

export default async function DatasetPage() {
  const studies = await getStudies();

  return (
    <div className="min-h-screen bg-[#f7f9fa]">
      <header className="bg-white">
        <div className="mx-auto max-w-7xl px-6 py-12 sm:px-8 sm:py-16">
          <p className="text-xs font-bold uppercase text-cyan-800">Open study materials</p>
          <h1 className="mt-3 font-serif text-4xl font-bold text-gray-950">Datasets</h1>
        </div>
      </header>
      <DatasetCatalog studies={studies} />
    </div>
  );
}
