"use client";
import { usePathname } from "next/navigation";
import { isStudioEditorRoute } from "@/lib/studio/editor-route";

export default function Footer() {
  if (isStudioEditorRoute(usePathname())) return null;
  return (
    <footer className="bg-white border-t border-gray-200 mt-auto">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <p className="text-center text-sm text-gray-500">
          &copy; 2026 HumanStudy-Hub Team. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
